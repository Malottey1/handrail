import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { CallLog } from "../src/audit.js";
import type { PayPalRest } from "../src/paypal/rest.js";
import { handleWebhook } from "../src/webhook-endpoint.js";
import { matchEvent, WebhookStore, type ForwardedCall, type WebhookEvent } from "../src/webhooks.js";

const usd = (value: string) => ({ hundredths: Math.round(Number(value) * 100), currency: "USD" });

function call(overrides: Partial<ForwardedCall>): ForwardedCall {
  return { id: 1, tool: "create_refund", createdAt: "2026-10-10T12:00:00Z", args: {}, response: null, amount: null, outcome: "succeeded", ...overrides };
}

// Shapes follow PayPal's webhook event payloads.
function refundEvent(opts: { refundId?: string; captureId?: string; value?: string; id?: string } = {}): WebhookEvent {
  return {
    id: opts.id ?? "WH-REFUND-1",
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    summary: "A $5.00 USD capture payment was refunded",
    resource: {
      id: opts.refundId ?? "REFUND123",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: opts.value ?? "5.00" },
      links: [
        { rel: "self", href: `https://api.sandbox.paypal.com/v2/payments/refunds/${opts.refundId ?? "REFUND123"}` },
        { rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${opts.captureId ?? "CAPTURE123"}` },
      ],
    },
  };
}

describe("matchEvent", () => {
  it("matches a refund event to the agent call by refund id", () => {
    const result = matchEvent(refundEvent(), [call({ id: 7, response: { id: "REFUND123" }, amount: usd("5.00") })]);
    assert.deepEqual(result, { status: "matched", tool: "create_refund", callId: 7, resourceId: "REFUND123", reasons: [] });
  });

  it("matches a refund event by the capture it refunds", () => {
    const result = matchEvent(refundEvent(), [call({ id: 3, args: { capture_id: "CAPTURE123" }, amount: usd("5.00") })]);
    assert.equal(result.status, "matched");
    assert.equal(result.callId, 3);
  });

  it("attributes each refund on a capture to the call that made it", () => {
    const calls = [
      call({ id: 2, args: { capture_id: "CAPTURE123" }, response: { id: "REFUND2" }, amount: usd("120.00") }),
      call({ id: 1, args: { capture_id: "CAPTURE123" }, response: { id: "REFUND1" }, amount: usd("5.00") }),
    ];
    // A late webhook for the older refund: not a mismatch against the newer one.
    const older = matchEvent(refundEvent({ refundId: "REFUND1", value: "5.00" }), calls);
    assert.deepEqual([older.status, older.callId], ["matched", 1]);
    const newer = matchEvent(refundEvent({ refundId: "REFUND2", value: "120.00" }), calls);
    assert.deepEqual([newer.status, newer.callId], ["matched", 2]);
  });

  it("flags a refund on a capture the agent also refunded, if no call made that refund", () => {
    const result = matchEvent(refundEvent({ refundId: "BYPASS", value: "5.00" }), [
      call({ args: { capture_id: "CAPTURE123" }, response: { id: "REFUND1" }, amount: usd("5.00") }),
    ]);
    assert.equal(result.status, "outside_handrail");
    assert.equal(result.callId, null);
  });

  it("prefers the call with the refund id over a newer call with no recorded refund", () => {
    const result = matchEvent(refundEvent({ refundId: "REFUND1", value: "5.00" }), [
      call({ id: 2, args: { capture_id: "CAPTURE123" }, amount: usd("120.00"), outcome: "unknown" }),
      call({ id: 1, args: { capture_id: "CAPTURE123" }, response: { id: "REFUND1" }, amount: usd("5.00") }),
    ]);
    assert.deepEqual([result.status, result.callId], ["matched", 1]);
  });

  it("matches by capture a call with no refund id on record, flagging an unknown outcome", () => {
    const pending = matchEvent(refundEvent(), [call({ id: 3, args: { capture_id: "CAPTURE123" }, amount: usd("5.00"), outcome: "unknown" })]);
    assert.deepEqual([pending.status, pending.callId], ["mismatch", 3]);
    const failed = matchEvent(refundEvent(), [
      call({ id: 4, args: { capture_id: "CAPTURE123" }, response: { ok: false, status: 500 }, amount: usd("5.00"), outcome: "failed" }),
    ]);
    assert.deepEqual([failed.status, failed.callId], ["mismatch", 4]);
  });

  it("flags a refund amount that differs from what the agent asked for", () => {
    const result = matchEvent(refundEvent({ value: "50.00" }), [call({ response: { id: "REFUND123" }, amount: usd("5.00") })]);
    assert.equal(result.status, "mismatch");
    assert.match(result.reasons[0]!, /PayPal reports 50\.00 USD, but the agent call was for 5\.00 USD/);
  });

  it("flags an event for a call Handrail recorded as failed or unknown", () => {
    const result = matchEvent(refundEvent(), [call({ response: { id: "REFUND123" }, amount: usd("5.00"), outcome: "unknown" })]);
    assert.equal(result.status, "mismatch");
    assert.match(result.reasons[0]!, /recorded the call's outcome as unknown/);
  });

  it("flags a refund no agent call made as outside Handrail", () => {
    const result = matchEvent(refundEvent(), [call({ args: { capture_id: "OTHER" }, response: { id: "OTHER" } })]);
    assert.equal(result.status, "outside_handrail");
    assert.match(result.reasons[0]!, /no agent call through Handrail made/);
  });

  it("matches a capture to the pay_order call by order id", () => {
    const event: WebhookEvent = {
      id: "WH-CAP-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP9", amount: { currency_code: "USD", value: "20.00" }, supplementary_data: { related_ids: { order_id: "ORDER9" } } },
    };
    const result = matchEvent(event, [call({ id: 4, tool: "pay_order", args: { id: "ORDER9" }, amount: usd("20.00") })]);
    assert.equal(result.status, "matched");
    assert.equal(result.callId, 4);
  });

  it("treats a customer's own capture as unrelated, not flagged", () => {
    const event: WebhookEvent = { id: "WH-CAP-2", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP1", amount: { currency_code: "USD", value: "20.00" } } };
    assert.equal(matchEvent(event, []).status, "unrelated");
  });

  it("matches invoice cancellations and flags ones made elsewhere", () => {
    const event: WebhookEvent = { id: "WH-INV-1", event_type: "INVOICING.INVOICE.CANCELLED", resource: { invoice: { id: "INV2-AAAA" } } };
    assert.equal(matchEvent(event, [call({ tool: "cancel_sent_invoice", args: { invoice_id: "INV2-AAAA" } })]).status, "matched");
    assert.equal(matchEvent(event, []).status, "outside_handrail");
  });

  it("ignores event types it doesn't track", () => {
    assert.equal(matchEvent({ id: "x", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} }, []).status, "ignored");
  });
});

describe("POST /webhooks/paypal", () => {
  let server: Server;
  let url: string;
  let verifyAnswer = "SUCCESS";
  let allowUnverified = false;
  let verifyRequests: unknown[] = [];
  const db = new DatabaseSync(":memory:");
  const callLog = new CallLog(db);
  const store = new WebhookStore(db);

  const rest = {
    async post(path: string, body: unknown) {
      assert.equal(path, "/v1/notifications/verify-webhook-signature");
      verifyRequests.push(body);
      return { verification_status: verifyAnswer };
    },
  } as unknown as PayPalRest;

  const signed = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-10-10T12:00:00Z",
  };

  const post = (event: unknown, headers: Record<string, string> = signed) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(event) });

  before(async () => {
    server = createServer((req, res) => void handleWebhook(req, res, { rest, callLog, store, webhookId: "WH-ID-1", allowUnverified }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/paypal`;
  });
  after(() => server.close());

  it("verifies the signature with PayPal and stores the matched event", async () => {
    const res = await post(refundEvent({ id: "WH-A" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "outside_handrail" });
    const sent = verifyRequests.at(-1) as Record<string, unknown>;
    assert.equal(sent.webhook_id, "WH-ID-1");
    assert.equal(sent.transmission_id, "tx-1");
    assert.equal((sent.webhook_event as WebhookEvent).id, "WH-A");
    assert.equal(store.list()[0]!.event_id, "WH-A");
  });

  it("stores a redelivered event only once", async () => {
    const before = verifyRequests.length;
    const res = await post(refundEvent({ id: "WH-A" }));
    assert.deepEqual(await res.json(), { ok: true, duplicate: true });
    assert.equal(verifyRequests.length, before);
    assert.equal(store.list().filter((e) => e.event_id === "WH-A").length, 1);
  });

  it("rejects events that fail verification", async () => {
    verifyAnswer = "FAILURE";
    const res = await post(refundEvent({ id: "WH-B" }));
    assert.equal(res.status, 400);
    assert.equal(store.list().some((e) => e.event_id === "WH-B"), false);
    verifyAnswer = "SUCCESS";
  });

  it("rejects events without PayPal's signature headers, without asking PayPal", async () => {
    const before = verifyRequests.length;
    const res = await post(refundEvent({ id: "WH-C" }), {});
    assert.equal(res.status, 400);
    assert.equal(verifyRequests.length, before);
  });

  it("accepts unverified events only when explicitly allowed, and marks them", async () => {
    allowUnverified = true;
    const res = await post(refundEvent({ id: "WH-D" }), {});
    assert.equal(res.status, 200);
    assert.equal(store.list().find((e) => e.event_id === "WH-D")!.verified, 0);
    allowUnverified = false;
  });

  it("rejects bodies that aren't PayPal events", async () => {
    assert.equal((await post({ hello: "world" })).status, 400);
    assert.equal((await fetch(url, { method: "POST", body: "not json" })).status, 400);
  });
});
