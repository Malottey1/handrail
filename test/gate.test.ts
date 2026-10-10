import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalStore } from "../src/approvals.js";
import { CallLog } from "../src/audit.js";
import { DecisionError, Gate } from "../src/gate.js";
import { canonicalJson, classifyOutcome, OperationStore, operationKey } from "../src/idempotency.js";
import { NoResponseError } from "../src/paypal/direct.js";
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
const MINUTE = 60_000;

type PayPalMode = "ok" | "404" | "no_response";

interface SentCall {
  via: "mcp" | "direct";
  name: string;
  arguments?: Record<string, unknown>;
  requestId?: string;
}

function setup(opts: { waitMs?: number; ttlMs?: number; captureAmount?: string | null; paypal?: PayPalMode; db?: DatabaseSync } = {}) {
  const sent: SentCall[] = [];
  const state = { paypal: opts.paypal ?? ("ok" as PayPalMode) };

  // Both paths answer like PayPal, after a short delay so concurrent calls overlap.
  async function answer(call: SentCall): Promise<CallToolResult> {
    sent.push(call);
    await new Promise((r) => setTimeout(r, 10));
    if (state.paypal === "no_response") throw new NoResponseError("No response from PayPal: timeout");
    return { content: [{ type: "text", text: state.paypal === "404" ? PAYPAL_404 : `paypal:${call.name}` }] };
  }

  const upstream = {
    callTool: (params: { name: string; arguments?: Record<string, unknown> }) => answer({ via: "mcp", ...params }),
  } as unknown as Client;
  const direct = {
    call: (name: string, args: Record<string, unknown>, requestId: string) => answer({ via: "direct", name, arguments: args, requestId }),
  };
  const rest = {
    async get(path: string) {
      await new Promise((r) => setTimeout(r, 5)); // force interleaving between concurrent calls
      if (opts.captureAmount === null || !path.startsWith("/v2/payments/captures/")) throw new Error("HTTP 404");
      return { amount: { currency_code: "USD", value: opts.captureAmount ?? "40.00" } };
    },
  } as unknown as PayPalRest;

  let clock = Date.parse("2026-10-10T12:00:00Z");
  const db = opts.db ?? new DatabaseSync(":memory:");
  const callLog = new CallLog(db);
  const operations = new OperationStore(db, 60 * MINUTE);
  const gate = new Gate(
    { upstream, rest, direct, callLog, approvals: new ApprovalStore(db), operations, policy: () => POLICY },
    { approvalWaitMs: opts.waitMs ?? 0, approvalTtlMs: opts.ttlMs ?? 60 * MINUTE, now: () => clock },
  );
  return {
    gate,
    sent,
    callLog,
    operations,
    db,
    advance: (ms: number) => (clock += ms),
    setPayPal: (mode: PayPalMode) => (state.paypal = mode),
  };
}

/** A refund. Pass a key to make otherwise-identical refunds distinct operations. */
const refund = (value?: string, key?: string) => ({
  capture_id: "CAPTURE0000000001",
  ...(value ? { amount: { currency_code: "USD", value } } : {}),
  ...(key ? { idempotency_key: key } : {}),
});

function handrailPayload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return JSON.parse((first as { text: string }).text).handrail;
}

const texts = (result: CallToolResult) => result.content.map((c) => (c as { text: string }).text);

describe("gate: forwarding", () => {
  it("forwards MCP tools with the agent's arguments, minus idempotency_key", async () => {
    const { gate, sent } = setup();
    const result = await gate.handle("send_invoice", { invoice_id: "INV2-AAAA", idempotency_key: "k1" });
    assert.deepEqual(sent, [{ via: "mcp", name: "send_invoice", arguments: { invoice_id: "INV2-AAAA" } }]);
    assert.deepEqual(result.content, [{ type: "text", text: "paypal:send_invoice" }]);
  });

  it("sends refunds directly with a PayPal-Request-Id", async () => {
    const { gate, sent } = setup();
    await gate.handle("create_refund", refund("50.00"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.via, "direct");
    assert.match(sent[0]!.requestId!, /^handrail-[0-9a-f]{40}$/);
    assert.deepEqual(sent[0]!.arguments, refund("50.00"));
  });

  it("forwards read tools without an operation", async () => {
    const { gate, sent } = setup();
    await gate.handle("list_invoices", {});
    await gate.handle("list_invoices", {});
    assert.equal(sent.length, 2);
  });
});

describe("gate: policy and approval", () => {
  it("never forwards blocked calls", async () => {
    const { gate, sent } = setup();
    const result = await gate.handle("create_refund", refund("5000.00"));
    assert.equal(sent.length, 0);
    assert.equal(result.isError, true);
    assert.equal(handrailPayload(result).status, "blocked");
  });

  it("holds over-limit calls and forwards exactly once on approval", async () => {
    const { gate, sent } = setup();
    const held = handrailPayload(await gate.handle("create_refund", refund("250.00")));
    assert.equal(held.status, "pending_approval");
    assert.equal(sent.length, 0);

    const id = held.approval_id as string;
    const approval = await gate.approve(id, "malcolm", "customer verified");
    assert.equal(approval.status, "executed");
    assert.equal(sent.length, 1);

    await assert.rejects(gate.approve(id, "malcolm", null), (err: DecisionError) => err.status === 409);
    assert.throws(() => gate.reject(id, "malcolm", null), (err: DecisionError) => err.status === 409);
    assert.equal(sent.length, 1);
  });

  it("forwards once when two approvals race", async () => {
    const { gate, sent } = setup();
    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    const results = await Promise.allSettled([gate.approve(id, "a", null), gate.approve(id, "b", null)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(sent.length, 1);
  });

  it("returns PayPal's result inline when approved during the wait", async () => {
    const { gate, sent } = setup({ waitMs: 2000 });
    const pending = gate.handle("create_refund", refund("250.00"));
    await new Promise((r) => setTimeout(r, 50));
    await gate.approve(gate.listApprovals("pending")[0]!.id, "malcolm", null);

    const result = await pending;
    assert.equal(sent.length, 1);
    assert.match(texts(result)[0]!, /approved by malcolm/);
    assert.equal(texts(result)[1], "paypal:create_refund");
  });

  it("does not forward rejected calls", async () => {
    const { gate, sent } = setup({ waitMs: 2000 });
    const pending = gate.handle("create_refund", refund("250.00"));
    await new Promise((r) => setTimeout(r, 50));
    gate.reject(gate.listApprovals("pending")[0]!.id, "malcolm", "looks like fraud");
    const payload = handrailPayload(await pending);
    assert.equal(payload.status, "rejected");
    assert.equal(payload.note, "looks like fraud");
    assert.equal(sent.length, 0);
  });

  it("expires approvals nobody decided", async () => {
    const { gate, sent, advance } = setup({ ttlMs: MINUTE });
    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    advance(MINUTE + 1);
    await assert.rejects(gate.approve(id, "malcolm", null), /expired/);
    assert.equal(gate.getApproval(id)!.status, "expired");
    assert.equal(sent.length, 0);
  });

  it("blocks an approved call if a limit was used up while it waited", async () => {
    const { gate, sent } = setup();
    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    for (let i = 0; i < 3; i++) await gate.handle("create_refund", refund("10.00", `k${i}`));
    assert.equal(sent.length, 3);

    assert.equal((await gate.approve(id, "malcolm", null)).status, "blocked");
    assert.equal(sent.length, 3);
  });

  it("looks up the capture amount when a refund omits it", async () => {
    const { gate, sent } = setup({ captureAmount: "750.00" });
    const payload = handrailPayload(await gate.handle("create_refund", refund()));
    assert.equal(payload.status, "pending_approval");
    assert.match(payload.reason as string, /750\.00 USD/);
    assert.equal(sent.length, 0);
  });

  it("holds a refund whose amount can't be determined", async () => {
    const { gate, sent } = setup({ captureAmount: null });
    const payload = handrailPayload(await gate.handle("create_refund", refund()));
    assert.equal(payload.status, "pending_approval");
    assert.match(payload.reason as string, /unknown/);
    assert.equal(sent.length, 0);
  });

  it("enforces rate limits under a concurrent burst of distinct refunds", async () => {
    const { gate, sent } = setup();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => gate.handle("create_refund", refund("10.00", `burst-${i}`))));
    assert.equal(sent.length, 3);
    assert.equal(results.filter((r) => r.isError).length, 3);
  });

  it("answers handrail_get_approval", async () => {
    const { gate } = setup();
    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    assert.equal(handrailPayload(await gate.handle("handrail_get_approval", { approval_id: id })).status, "pending_approval");
    await gate.approve(id, "malcolm", null);
    const done = await gate.handle("handrail_get_approval", { approval_id: id });
    assert.match(texts(done)[0]!, /approved by malcolm/);
    assert.equal(handrailPayload(await gate.handle("handrail_get_approval", { approval_id: "nope" })).status, "not_found");
  });
});

describe("gate: idempotency", () => {
  it("answers a repeat of a succeeded call from the stored result", async () => {
    const { gate, sent, callLog } = setup();
    await gate.handle("create_refund", refund("50.00"));
    const repeat = await gate.handle("create_refund", refund("50.00"));
    assert.equal(sent.length, 1);
    assert.match(texts(repeat)[0]!, /Duplicate of an identical create_refund call/);
    assert.equal(texts(repeat)[1], "paypal:create_refund");
    assert.deepEqual(callLog.recent(2).map((r) => r.decision), ["duplicate", "allow"]);
  });

  it("sends one refund for a concurrent retry storm", async () => {
    const { gate, sent } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => gate.handle("create_refund", refund("50.00"))));
    assert.equal(sent.length, 1);
    for (const r of results) assert.ok(texts(r).includes("paypal:create_refund"));
  });

  it("treats argument key order as irrelevant", async () => {
    const { gate, sent } = setup();
    await gate.handle("create_refund", { capture_id: "CAPTURE0000000001", amount: { currency_code: "USD", value: "50.00" } });
    await gate.handle("create_refund", { amount: { value: "50.00", currency_code: "USD" }, capture_id: "CAPTURE0000000001" });
    assert.equal(sent.length, 1);
  });

  it("lets an explicit idempotency_key decide what counts as the same operation", async () => {
    const { gate, sent } = setup();
    await gate.handle("create_refund", refund("50.00", "order-42"));
    await gate.handle("create_refund", refund("50.00", "order-42"));
    await gate.handle("create_refund", refund("50.00", "order-43"));
    assert.equal(sent.length, 2);
  });

  it("treats an identical call after the window as a new operation", async () => {
    const { gate, sent, advance } = setup();
    await gate.handle("create_refund", refund("50.00"));
    advance(61 * MINUTE);
    await gate.handle("create_refund", refund("50.00"));
    assert.equal(sent.length, 2);
  });

  it("keeps explicit keys beyond the window", async () => {
    const { gate, sent, advance } = setup();
    await gate.handle("create_refund", refund("50.00", "order-42"));
    advance(24 * 60 * MINUTE);
    await gate.handle("create_refund", refund("50.00", "order-42"));
    assert.equal(sent.length, 1);
  });

  it("retries a definite failure as a new attempt with a new request id", async () => {
    const { gate, sent, setPayPal } = setup({ paypal: "404" });
    await gate.handle("create_refund", refund("50.00"));
    setPayPal("ok");
    await gate.handle("create_refund", refund("50.00"));
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0]!.requestId, sent[1]!.requestId);
  });

  it("retries an unknown-outcome refund with the same request id, so PayPal de-duplicates", async () => {
    const { gate, sent, setPayPal } = setup({ paypal: "no_response" });
    const first = await gate.handle("create_refund", refund("50.00"));
    assert.equal(handrailPayload(first).status, "outcome_unknown");
    setPayPal("ok");
    await gate.handle("create_refund", refund("50.00"));
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.requestId, sent[1]!.requestId);
  });

  it("holds a retry of an unknown-outcome MCP call for a human", async () => {
    const { gate, sent, setPayPal } = setup({ paypal: "no_response" });
    await gate.handle("send_invoice", { invoice_id: "INV2-AAAA" });
    setPayPal("ok");
    const retry = handrailPayload(await gate.handle("send_invoice", { invoice_id: "INV2-AAAA" }));
    assert.equal(retry.status, "pending_approval");
    assert.match(retry.reason as string, /may already have run/);
    assert.equal(sent.length, 1);
  });

  it("reuses the pending approval for a repeat of a held call", async () => {
    const { gate, sent } = setup();
    const first = handrailPayload(await gate.handle("create_refund", refund("250.00")));
    const repeat = handrailPayload(await gate.handle("create_refund", refund("250.00")));
    assert.equal(repeat.approval_id, first.approval_id);
    assert.equal(gate.listApprovals("pending").length, 1);

    await gate.approve(first.approval_id as string, "malcolm", null);
    const afterApproval = await gate.handle("create_refund", refund("250.00"));
    assert.match(texts(afterApproval)[0]!, /Duplicate/);
    assert.equal(sent.length, 1);
  });

  it("repeats the rejection for a repeat of a rejected call", async () => {
    const { gate, sent } = setup();
    const id = handrailPayload(await gate.handle("create_refund", refund("250.00"))).approval_id as string;
    gate.reject(id, "malcolm", "no");
    assert.equal(handrailPayload(await gate.handle("create_refund", refund("250.00"))).status, "rejected");
    assert.equal(sent.length, 0);
  });

  it("lets a call whose approval expired be tried again", async () => {
    const { gate, advance } = setup({ ttlMs: MINUTE });
    const first = handrailPayload(await gate.handle("create_refund", refund("250.00")));
    advance(MINUTE + 1);
    const second = handrailPayload(await gate.handle("create_refund", refund("250.00")));
    assert.equal(second.status, "pending_approval");
    assert.notEqual(second.approval_id, first.approval_id);
  });

  it("marks calls interrupted by a restart as unknown and reuses their request id", async () => {
    const db = new DatabaseSync(":memory:");
    const before = setup({ db });
    const op = operationKey("create_refund", refund("50.00"))!;
    const interrupted = before.operations.begin(op, "create_refund", "in_flight", null, Date.parse("2026-10-10T12:00:00Z"));

    const after = setup({ db }); // a new Gate on the same database = restart
    assert.equal(after.operations.get(op.key, Date.parse("2026-10-10T12:00:00Z"))!.status, "unknown");
    await after.gate.handle("create_refund", refund("50.00"));
    assert.equal(after.sent.length, 1);
    assert.equal(after.sent[0]!.requestId, interrupted.requestId);
  });

  it("does not count failed calls toward rate limits", async () => {
    const { gate, sent } = setup({ paypal: "404" });
    for (let i = 0; i < 5; i++) await gate.handle("create_refund", refund("10.00"));
    assert.equal(sent.length, 5);
  });

  it("logs every call with its decision and outcome", async () => {
    const { gate, callLog } = setup();
    await gate.handle("create_refund", refund("50.00"));
    await gate.handle("create_refund", refund("50.00"));
    await gate.handle("create_refund", refund("250.00"));
    await gate.handle("create_refund", refund("5000.00"));
    const rows = callLog.recent(10).reverse();
    assert.deepEqual(rows.map((r) => [r.decision, r.forwarded, r.outcome]), [
      ["allow", 1, "succeeded"],
      ["duplicate", 0, "duplicate"],
      ["require_approval", 0, "held"],
      ["block", 0, "blocked"],
    ]);
    assert.match(rows[0]!.request_id!, /^handrail-/);
    assert.ok(rows[2]!.approval_id?.startsWith("apr_"));
  });
});

describe("idempotency helpers", () => {
  it("produces canonical JSON", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[2,{"x":2,"y":1}]},"b":1}');
  });

  it("gives read tools no operation", () => {
    assert.equal(operationKey("list_invoices", {}), null);
  });

  it("classifies PayPal outcomes", () => {
    const body = (o: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
    assert.equal(classifyOutcome(body({ id: "R1", status: "COMPLETED" }), false), "succeeded");
    assert.equal(classifyOutcome(body({ ok: false, status: 404 }), false), "failed");
    assert.equal(classifyOutcome(body({ ok: false, status: 422 }), false), "failed");
    assert.equal(classifyOutcome(body({ ok: false, status: 503 }), false), "unknown");
    assert.equal(classifyOutcome(body({ ok: false, code: "PAYPAL_API_NO_RESPONSE" }), false), "unknown");
    assert.equal(classifyOutcome({ content: [], isError: true }, false), "failed");
    assert.equal(classifyOutcome({ content: [] }, true), "unknown");
    assert.equal(classifyOutcome({ content: [{ type: "text", text: "plain" }] }, false), "succeeded");
  });
});
