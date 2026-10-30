import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalStore } from "../src/approvals.js";
import { AuditChain } from "../src/audit-chain.js";
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

// setup_error_no_response: the MCP server fails before sending, then the REST fallback gets no answer.
type PayPalMode = "ok" | "404" | "no_response" | "setup_error" | "setup_error_no_response";

// What PayPal's sandbox MCP server answers while paypal/AI-Toolkit issue #34 is open.
const SETUP_ERROR = JSON.stringify({ ok: false, code: "PAYPAL_API_SETUP_ERROR", message: "Unsupported cache mode: default" });

interface SentCall {
  via: "mcp" | "direct" | "rest";
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
    if (state.paypal.startsWith("setup_error") && call.via === "mcp") return { content: [{ type: "text", text: SETUP_ERROR }] };
    if (state.paypal === "setup_error_no_response") throw new NoResponseError("No response from PayPal: timeout");
    return { content: [{ type: "text", text: state.paypal === "404" ? PAYPAL_404 : `paypal:${call.name}` }] };
  }

  const upstream = {
    callTool: (params: { name: string; arguments?: Record<string, unknown> }) => answer({ via: "mcp", ...params }),
  } as unknown as Client;
  const direct = {
    call: (name: string, args: Record<string, unknown>, requestId: string) => answer({ via: "direct", name, arguments: args, requestId }),
    read: (name: string, args: Record<string, unknown>) => answer({ via: "rest", name, arguments: args }),
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

/** Handrail's JSON block (after the plain-words instruction for the model). */
function handrailPayload(result: CallToolResult): Record<string, unknown> {
  for (const block of result.content) {
    if (block.type !== "text") continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed?.handrail) return parsed.handrail;
    } catch {
      // the plain-words line
    }
  }
  assert.fail(`no Handrail JSON in ${JSON.stringify(result)}`);
}

const texts = (result: CallToolResult) => result.content.map((c) => (c as { text: string }).text);

describe("gate: what the model is told", () => {
  const first = (r: CallToolResult) => (r.content[0] as { text: string }).text;

  it("held, blocked, rejected and expired results start with plain instructions, repeated as next_step", async () => {
    const { gate, advance } = setup({ ttlMs: MINUTE });
    const held = await gate.handle("create_refund", refund("250.00", "k1"));
    const id = handrailPayload(held).approval_id as string;
    assert.match(first(held), new RegExp(`^Not executed\\. Pending human approval \\(id ${id}\\)\\. Do not retry this call\\. Tell the user it is awaiting review; use handrail_get_approval with approval_id "${id}" to check later\\.`));
    assert.match(first(held), /Why it was held: 250\.00 USD is over the 100\.00 USD ceiling/);
    assert.equal(handrailPayload(held).next_step, first(held));
    assert.equal(held.isError, false);

    const blocked = await gate.handle("create_refund", refund("5000.00", "k2"));
    assert.match(first(blocked), /^Not executed\. Blocked by policy: .*1000\.00 USD ceiling.*Do not retry this call, and don't try to get around the limit \(for example by splitting it into smaller calls\)\. Tell the user it was blocked and why\.$/);
    assert.equal(blocked.isError, true);

    const toReject = handrailPayload(await gate.handle("create_refund", refund("300.00", "k3"))).approval_id as string;
    gate.reject(toReject, "Ada", "Not a real complaint");
    const rejected = await gate.handle("handrail_get_approval", { approval_id: toReject });
    assert.equal(first(rejected), `Not executed. A person rejected this request (id ${toReject}): "Not a real complaint". Do not retry this call. Tell the user it was rejected.`);

    advance(MINUTE + 1);
    const expired = await gate.handle("handrail_get_approval", { approval_id: id });
    assert.match(first(expired), /^Not executed\. The approval request \(id .*\) expired because nobody decided in time, so nothing was sent to PayPal\. Do not retry it automatically\./);

    const missing = await gate.handle("handrail_get_approval", { approval_id: "apr_nope" });
    assert.match(first(missing), /no held call with approval_id "apr_nope"/);
  });

  it("a retry of a held call gets the same instructions, not a second approval", async () => {
    const { gate } = setup();
    const a = await gate.handle("create_refund", refund("250.00", "same"));
    const b = await gate.handle("create_refund", refund("250.00", "same"));
    assert.equal(first(b), first(a));
  });
});

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

  it("answers a read from the REST API when PayPal's MCP server fails before sending", async () => {
    const { gate, sent, callLog } = setup({ paypal: "setup_error" });
    const result = await gate.handle("list_disputes", { dispute_state: "OPEN_INQUIRIES" });
    assert.deepEqual(
      sent.map((c) => [c.via, c.name]),
      [
        ["mcp", "list_disputes"],
        ["rest", "list_disputes"],
      ],
    );
    assert.deepEqual(sent[1]!.arguments, { dispute_state: "OPEN_INQUIRIES" });
    assert.deepEqual(result.content, [{ type: "text", text: "paypal:list_disputes" }]);
    assert.equal(callLog.recent(1)[0]!.outcome, "succeeded");
  });

  for (const [tool, args] of [
    ["send_invoice", { invoice_id: "INV2-AAAA", send_to_recipient: true }],
    ["cancel_sent_invoice", { invoice_id: "INV2-AAAA", note: "Sent in error" }],
    ["cancel_subscription", { subscription_id: "I-SUB123", payload: { reason: "Customer asked" } }],
  ] as const) {
    it(`sends ${tool} via REST with a PayPal-Request-Id when PayPal's MCP server fails before sending`, async () => {
      const { gate, sent, callLog } = setup({ paypal: "setup_error" });
      const result = await gate.handle(tool, { ...args });
      assert.deepEqual(
        sent.map((c) => [c.via, c.name]),
        [
          ["mcp", tool],
          ["direct", tool],
        ],
      );
      assert.deepEqual(sent[1]!.arguments, args);
      assert.match(sent[1]!.requestId!, /^handrail-[0-9a-f]{40}$/);
      assert.deepEqual(result.content, [{ type: "text", text: `paypal:${tool}` }]);
      assert.equal(callLog.recent(1)[0]!.outcome, "succeeded");

      // A retry is answered from the record: nothing goes to PayPal twice.
      await gate.handle(tool, { ...args });
      assert.equal(sent.length, 2);
    });

    it(`sends ${tool} through PayPal's MCP server when it works`, async () => {
      const { gate, sent } = setup();
      await gate.handle(tool, { ...args });
      assert.deepEqual(
        sent.map((c) => c.via),
        ["mcp"],
      );
    });
  }

  it("leaves other tools' setup errors with PayPal, recorded as failed: nothing was sent", async () => {
    const { gate, sent, callLog } = setup({ paypal: "setup_error" });
    const result = await gate.handle("send_invoice_reminder", { invoice_id: "INV2-AAAA" });
    assert.deepEqual(
      sent.map((c) => c.via),
      ["mcp"],
    );
    assert.equal(texts(result)[0], SETUP_ERROR);
    assert.equal(callLog.recent(1)[0]!.outcome, "failed");
  });

  it("sends dispute concessions directly with a PayPal-Request-Id, never through the MCP server", async () => {
    const { gate, sent } = setup({ paypal: "setup_error" });
    const result = await gate.handle("accept_dispute_claim", { dispute_id: "PP-D-1234", note: "Refund agreed" });
    assert.deepEqual(result.content, [{ type: "text", text: "paypal:accept_dispute_claim" }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.via, "direct");
    assert.deepEqual(sent[0]!.arguments, { dispute_id: "PP-D-1234", note: "Refund agreed" });
    assert.match(sent[0]!.requestId!, /^handrail-[0-9a-f]{40}$/);
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

  it("records the request id a REST fallback write went out with, and reuses it on the retry", async () => {
    const { gate, sent, callLog, setPayPal } = setup({ paypal: "setup_error_no_response" });
    const first = await gate.handle("send_invoice", { invoice_id: "INV2-AAAA" });
    assert.equal(handrailPayload(first).status, "outcome_unknown");
    const sentWith = sent[1]!.requestId!;
    assert.match(sentWith, /^handrail-[0-9a-f]{40}$/);
    assert.equal(callLog.recent(1)[0]!.request_id, sentWith);

    // The retry may duplicate an invoice that was sent, so a human approves it,
    // and it goes out with the same id for PayPal to de-duplicate.
    setPayPal("setup_error");
    const retry = handrailPayload(await gate.handle("send_invoice", { invoice_id: "INV2-AAAA" }));
    assert.equal(retry.status, "pending_approval");
    await gate.approve(retry.approval_id as string, "malcolm", null);
    assert.deepEqual(
      sent.map((c) => c.via),
      ["mcp", "direct", "mcp", "direct"],
    );
    assert.equal(sent[3]!.requestId, sentWith);
    const rows = callLog.recent(10).filter((r) => r.forwarded);
    assert.deepEqual(
      rows.map((r) => [r.outcome, r.request_id]),
      [
        ["succeeded", sentWith],
        ["unknown", sentWith],
      ],
    );
  });

  it("shows the original request id on a deduplicated retry", async () => {
    const { gate, sent, callLog } = setup({ paypal: "setup_error" });
    await gate.handle("cancel_sent_invoice", { invoice_id: "INV2-AAAA" });
    await gate.handle("cancel_sent_invoice", { invoice_id: "INV2-AAAA" });
    assert.equal(sent.length, 2); // MCP, then the REST fallback; the retry went nowhere
    const [retry, original] = callLog.recent(2);
    assert.equal(retry!.outcome, "duplicate");
    assert.equal(original!.request_id, sent[1]!.requestId);
    assert.equal(retry!.request_id, original!.request_id);
  });

  it("records no request id for calls PayPal's MCP server answered", async () => {
    const { gate, callLog } = setup();
    await gate.handle("send_invoice", { invoice_id: "INV2-AAAA" });
    await gate.handle("send_invoice", { invoice_id: "INV2-AAAA" });
    assert.deepEqual(
      callLog.recent(2).map((r) => r.request_id),
      [null, null],
    );
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
    assert.equal(classifyOutcome(body({ ok: false, code: "PAYPAL_API_SETUP_ERROR", message: "Unsupported cache mode: default" }), false), "failed");
    assert.equal(classifyOutcome({ content: [], isError: true }, false), "failed");
    assert.equal(classifyOutcome({ content: [] }, true), "unknown");
    assert.equal(classifyOutcome({ content: [{ type: "text", text: "plain" }] }, false), "succeeded");
  });
});

describe("audit chain through the gate", () => {
  it("every path (allow, duplicate, hold+approve, block, hold+reject, expire) leaves a verifiable chain", async () => {
    const { gate, advance, db } = setup();
    const refund = (value: string, key: string) =>
      gate.handle("create_refund", { capture_id: "CAP1", amount: { currency_code: "USD", value }, idempotency_key: key });

    await refund("10.00", "a");
    await refund("10.00", "a"); // duplicate
    await refund("150.00", "b");
    const [first] = gate.listApprovals("pending");
    await gate.approve(first!.id, "alice", null);
    await refund("5000.00", "c"); // blocked
    await refund("200.00", "d");
    gate.reject(gate.listApprovals("pending")[0]!.id, "bob", "no");
    await refund("300.00", "e");
    advance(61 * MINUTE);
    await refund("1.00", "f"); // triggers expiry of "e"

    const chain = new AuditChain(db);
    const result = chain.verify();
    assert.deepEqual(result.problems, []);
    const kinds = new Set(chain.list(1000).map((e) => e.kind));
    for (const kind of ["call.decided", "call.duplicate", "call.finished", "approval.created", "approval.decided", "approval.completed", "approval.expired"]) {
      assert.ok(kinds.has(kind as never), `missing ${kind}`);
    }
  });
});

describe("onHeld hook", () => {
  it("runs after a call is held, and a failing hook doesn't change the decision", async () => {
    const db = new DatabaseSync(":memory:");
    const seen: string[] = [];
    const base = setup({ db });
    const gate = new Gate(
      {
        upstream: {} as Client,
        rest: { get: async () => ({ amount: { currency_code: "USD", value: "40.00" } }) } as unknown as PayPalRest,
        direct: { call: async () => ({ content: [] }) },
        callLog: base.callLog,
        approvals: new ApprovalStore(db),
        operations: base.operations,
        policy: () => POLICY,
        onHeld: (a) => {
          seen.push(a.id);
          throw new Error("explainer exploded");
        },
      },
      { approvalWaitMs: 0, approvalTtlMs: 60 * MINUTE },
    );
    const result = await gate.handle("create_refund", { capture_id: "CAP1", amount: { currency_code: "USD", value: "150.00" } });
    assert.equal(seen.length, 1);
    assert.match(JSON.stringify(result.content), /pending_approval/);
    assert.equal(gate.listApprovals("pending")[0]!.id, seen[0]);
  });
});
