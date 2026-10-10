import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalStore } from "../src/approvals.js";
import { CallLog } from "../src/audit.js";
import { DecisionError, Gate, isUpstreamError } from "../src/gate.js";
import type { PayPalRest } from "../src/paypal/rest.js";
import { parsePolicy } from "../src/policy/load.js";

const POLICY = parsePolicy({
  version: 1,
  defaults: { read: "allow", write: "allow", money: "allow", unknown: "require_approval" },
  rules: [
    { id: "approve-over-100", type: "amount_ceiling", tools: ["create_refund"], max: "100.00", currency: "USD", decision: "require_approval" },
    { id: "block-over-1000", type: "amount_ceiling", tools: ["create_refund"], max: "1000.00", currency: "USD", decision: "block" },
    { id: "rate-3", type: "rate_limit", tools: ["create_refund"], max: 3, windowSeconds: 3600, decision: "block" },
  ],
});

const PAYPAL_404 = JSON.stringify({ ok: false, status: 404, code: "PAYPAL_API_HTTP_ERROR", message: "The specified resource does not exist." });

function setup(opts: { waitMs?: number; ttlMs?: number; captureAmount?: string | null; paypalFails?: boolean } = {}) {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const upstream = {
    async callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> {
      calls.push(params);
      return { content: [{ type: "text", text: opts.paypalFails ? PAYPAL_404 : `paypal:${params.name}` }] };
    },
  } as unknown as Client;

  const rest = {
    async get(path: string) {
      await new Promise((r) => setTimeout(r, 5)); // force interleaving between concurrent calls
      if (opts.captureAmount === null || !path.startsWith("/v2/payments/captures/")) throw new Error("HTTP 404");
      return { amount: { currency_code: "USD", value: opts.captureAmount ?? "40.00" } };
    },
  } as unknown as PayPalRest;

  let clock = Date.parse("2026-10-10T12:00:00Z");
  const db = new DatabaseSync(":memory:");
  const callLog = new CallLog(db);
  const gate = new Gate(upstream, rest, callLog, new ApprovalStore(db), () => POLICY, {
    approvalWaitMs: opts.waitMs ?? 0,
    approvalTtlMs: opts.ttlMs ?? 60_000,
    now: () => clock,
  });
  return { gate, calls, callLog, advance: (ms: number) => (clock += ms) };
}

const refund = (value?: string) => ({ capture_id: "CAPTURE0000000001", ...(value ? { amount: { currency_code: "USD", value } } : {}) });

function handrailPayload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return JSON.parse((first as { text: string }).text).handrail;
}

describe("gate", () => {
  it("forwards allowed calls unchanged", async () => {
    const { gate, calls } = setup();
    const result = await gate.handle("create_refund", refund("50.00"));
    assert.deepEqual(calls, [{ name: "create_refund", arguments: refund("50.00") }]);
    assert.deepEqual(result.content, [{ type: "text", text: "paypal:create_refund" }]);
  });

  it("never forwards blocked calls", async () => {
    const { gate, calls } = setup();
    const result = await gate.handle("create_refund", refund("5000.00"));
    assert.equal(calls.length, 0);
    assert.equal(result.isError, true);
    assert.equal(handrailPayload(result).status, "blocked");
  });

  it("holds over-limit calls and forwards exactly once on approval", async () => {
    const { gate, calls } = setup();
    const held = handrailPayload(await gate.handle("create_refund", refund("250.00")));
    assert.equal(held.status, "pending_approval");
    assert.equal(calls.length, 0);

    const id = held.approval_id as string;
    const approval = await gate.approve(id, "malcolm", "customer verified");
    assert.equal(approval.status, "executed");
    assert.equal(calls.length, 1);

    await assert.rejects(gate.approve(id, "malcolm", null), (err: DecisionError) => err.status === 409);
    assert.throws(() => gate.reject(id, "malcolm", null), (err: DecisionError) => err.status === 409);
    assert.equal(calls.length, 1);
  });

  it("forwards once when two approvals race", async () => {
    const { gate, calls } = setup();
    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    const results = await Promise.allSettled([gate.approve(id, "a", null), gate.approve(id, "b", null)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(calls.length, 1);
  });

  it("returns PayPal's result inline when approved during the wait", async () => {
    const { gate, calls } = setup({ waitMs: 2000 });
    const pending = gate.handle("create_refund", refund("250.00"));
    await new Promise((r) => setTimeout(r, 50));
    const [approval] = gate.listApprovals("pending");
    await gate.approve(approval!.id, "malcolm", null);

    const result = await pending;
    assert.equal(calls.length, 1);
    assert.match((result.content[0] as { text: string }).text, /approved by malcolm/);
    assert.deepEqual(result.content[1], { type: "text", text: "paypal:create_refund" });
  });

  it("does not forward rejected calls", async () => {
    const { gate, calls } = setup({ waitMs: 2000 });
    const pending = gate.handle("create_refund", refund("250.00"));
    await new Promise((r) => setTimeout(r, 50));
    gate.reject(gate.listApprovals("pending")[0]!.id, "malcolm", "looks like fraud");
    const payload = handrailPayload(await pending);
    assert.equal(payload.status, "rejected");
    assert.equal(payload.note, "looks like fraud");
    assert.equal(calls.length, 0);
  });

  it("expires approvals nobody decided", async () => {
    const { gate, calls, advance } = setup({ ttlMs: 60_000 });
    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    advance(60_001);
    await assert.rejects(gate.approve(id, "malcolm", null), /expired/);
    assert.equal(gate.getApproval(id)!.status, "expired");
    assert.equal(calls.length, 0);
  });

  it("blocks an approved call if a limit was used up while it waited", async () => {
    const { gate, calls } = setup();
    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    for (let i = 0; i < 3; i++) await gate.handle("create_refund", refund("10.00"));
    assert.equal(calls.length, 3);

    const approval = await gate.approve(id, "malcolm", null);
    assert.equal(approval.status, "blocked");
    assert.equal(calls.length, 3);
  });

  it("looks up the capture amount when a refund omits it", async () => {
    const { gate, calls } = setup({ captureAmount: "750.00" });
    const payload = handrailPayload(await gate.handle("create_refund", refund()));
    assert.equal(payload.status, "pending_approval");
    assert.match(payload.reason as string, /750\.00 USD/);
    assert.equal(calls.length, 0);
  });

  it("holds a refund whose amount can't be determined", async () => {
    const { gate, calls } = setup({ captureAmount: null });
    const payload = handrailPayload(await gate.handle("create_refund", refund()));
    assert.equal(payload.status, "pending_approval");
    assert.match(payload.reason as string, /unknown/);
    assert.equal(calls.length, 0);
  });

  it("enforces rate limits under a concurrent burst", async () => {
    const { gate, calls } = setup();
    const results = await Promise.all(Array.from({ length: 6 }, () => gate.handle("create_refund", refund("10.00"))));
    assert.equal(calls.length, 3);
    assert.equal(results.filter((r) => r.isError).length, 3);
  });

  it("logs every call with its decision", async () => {
    const { gate, callLog } = setup();
    await gate.handle("create_refund", refund("50.00"));
    await gate.handle("create_refund", refund("250.00"));
    await gate.handle("create_refund", refund("5000.00"));
    const rows = callLog.recent(10).reverse();
    assert.deepEqual(rows.map((r) => [r.decision, r.forwarded]), [
      ["allow", 1],
      ["require_approval", 0],
      ["block", 0],
    ]);
    assert.ok(rows[1]!.approval_id?.startsWith("apr_"));
  });

  it("treats PayPal's ok:false body as a failure without changing the result", async () => {
    const { gate, callLog } = setup({ paypalFails: true });
    const result = await gate.handle("create_refund", refund("50.00"));
    assert.deepEqual(result, { content: [{ type: "text", text: PAYPAL_404 }] });
    assert.equal(callLog.recent(1)[0]!.is_error, 1);

    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    assert.equal((await gate.approve(id, "malcolm", null)).status, "failed");
  });

  it("doesn't count failed calls toward rate limits", async () => {
    const { gate, calls } = setup({ paypalFails: true });
    for (let i = 0; i < 5; i++) await gate.handle("create_refund", refund("10.00"));
    assert.equal(calls.length, 5);
  });

  it("recognises upstream errors", () => {
    assert.equal(isUpstreamError({ content: [], isError: true }), true);
    assert.equal(isUpstreamError({ content: [{ type: "text", text: PAYPAL_404 }] }), true);
    assert.equal(isUpstreamError({ content: [{ type: "text", text: '{"ok":true,"id":"X"}' }] }), false);
    assert.equal(isUpstreamError({ content: [{ type: "text", text: "plain text" }] }), false);
  });

  it("answers handrail_get_approval", async () => {
    const { gate } = setup();
    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    assert.equal(handrailPayload(await gate.handle("handrail_get_approval", { approval_id: id })).status, "pending_approval");
    await gate.approve(id, "malcolm", null);
    const done = await gate.handle("handrail_get_approval", { approval_id: id });
    assert.match((done.content[0] as { text: string }).text, /approved by malcolm/);
    assert.equal(handrailPayload(await gate.handle("handrail_get_approval", { approval_id: "nope" })).status, "not_found");
  });
});
