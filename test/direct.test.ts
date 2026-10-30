import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { PayPalTokenManager } from "../src/paypal/auth.js";
import { PayPalDirect } from "../src/paypal/direct.js";

// The requests must match the Agent Toolkit's functions.ts (1.11.0), so the
// agent gets what PayPal's MCP server would have given it.

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakePayPal(status = 200, data: unknown = { id: "X" }) {
  const raw = data === null ? "" : JSON.stringify(data);
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      method: init.method ?? "GET",
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(status === 204 ? null : raw, { status });
  }) as typeof fetch;
  const tokens = { getToken: async () => "token" } as unknown as PayPalTokenManager;
  return { sent, direct: new PayPalDirect("https://api-m.sandbox.paypal.com", tokens) };
}

describe("direct REST calls", () => {
  it("accepts a dispute claim with the note and a PayPal-Request-Id", async () => {
    const { sent, direct } = fakePayPal();
    const result = await direct.call("accept_dispute_claim", { dispute_id: "PP-D-1234", note: "Refund agreed" }, "handrail-abc");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.url, "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1234/accept-claim");
    assert.deepEqual(sent[0]!.body, { note: "Refund agreed" });
    assert.equal(sent[0]!.headers["PayPal-Request-Id"], "handrail-abc");
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ id: "X" }) }]);
  });

  it("sends an invoice with all its arguments as the body, like the toolkit", async () => {
    const { sent, direct } = fakePayPal(200, { href: "https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA" });
    const args = { invoice_id: "INV2-AAAA", note: "Thanks", send_to_recipient: true, additional_recipients: ["a@example.com"] };
    const result = await direct.call("send_invoice", args, "handrail-send");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.url, "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-AAAA/send");
    assert.deepEqual(sent[0]!.body, args);
    assert.equal(sent[0]!.headers["PayPal-Request-Id"], "handrail-send");
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ href: "https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA" }) }]);
  });

  it("returns an empty send_invoice answer as the toolkit does (an empty string)", async () => {
    const { direct } = fakePayPal(202, null);
    const result = await direct.call("send_invoice", { invoice_id: "INV2-AAAA" }, "handrail-send");
    assert.deepEqual(result.content, [{ type: "text", text: '""' }]);
  });

  it("cancels a sent invoice and answers 204 with { success, invoice_id }", async () => {
    const { sent, direct } = fakePayPal(204);
    const args = { invoice_id: "INV2-AAAA", note: "Sent in error", send_to_recipient: true };
    const result = await direct.call("cancel_sent_invoice", args, "handrail-cancel");
    assert.equal(sent[0]!.url, "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-AAAA/cancel");
    assert.deepEqual(sent[0]!.body, args);
    assert.equal(sent[0]!.headers["PayPal-Request-Id"], "handrail-cancel");
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ success: true, invoice_id: "INV2-AAAA" }) }]);
  });

  it("cancels a subscription with the payload as the body", async () => {
    const { sent, direct } = fakePayPal(204);
    const result = await direct.call("cancel_subscription", { subscription_id: "I-SUB123", payload: { reason: "Customer asked" } }, "handrail-sub");
    assert.equal(sent[0]!.url, "https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-SUB123/cancel");
    assert.deepEqual(sent[0]!.body, { reason: "Customer asked" });
    assert.equal(sent[0]!.headers["PayPal-Request-Id"], "handrail-sub");
    assert.deepEqual(result.content, [{ type: "text", text: '""' }]);
  });

  it("returns a failed cancellation in the toolkit's error shape", async () => {
    const { direct } = fakePayPal(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SUBSCRIPTION_STATUS_INVALID", description: "Invalid subscription status for cancel action." }] });
    const result = await direct.call("cancel_subscription", { subscription_id: "I-SUB123", payload: { reason: "x" } }, "handrail-sub");
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
      ok: false,
      status: 422,
      code: "PAYPAL_API_HTTP_ERROR",
      message: "UNPROCESSABLE_ENTITY: Invalid subscription status for cancel action.",
    });
  });

  it("answers reads from the same URLs as the toolkit, with no request id", async () => {
    const { sent, direct } = fakePayPal();
    await direct.read("list_products", {});
    await direct.read("list_disputes", { dispute_state: "OPEN_INQUIRIES", page_size: 5, disputed_transaction_id: undefined });
    await direct.read("get_dispute", { dispute_id: "PP-D-1234" });
    await direct.read("show_product_details", { product_id: "PROD-1" });
    await direct.read("list_invoices", { page: 1 });
    await direct.read("get_invoice", { invoice_id: "INV2-AAAA" });
    assert.deepEqual(
      sent.map((s) => `${s.method} ${s.url.replace("https://api-m.sandbox.paypal.com", "")}`),
      [
        "GET /v1/catalogs/products?page_size=2&page=1&total_required=true",
        "GET /v1/customer/disputes?dispute_state=OPEN_INQUIRIES&page_size=5",
        "GET /v1/customer/disputes/PP-D-1234",
        "GET /v1/catalogs/products/PROD-1",
        "GET /v2/invoicing/invoices?page=1",
        "GET /v2/invoicing/invoices/INV2-AAAA",
      ],
    );
    assert.ok(sent.every((s) => !("PayPal-Request-Id" in s.headers) && s.body === undefined));
  });

  it("returns PayPal's HTTP errors in the toolkit's error shape", async () => {
    const { direct } = fakePayPal(404, { name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." });
    const result = await direct.read("get_dispute", { dispute_id: "PP-D-0000" });
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
      ok: false,
      status: 404,
      code: "PAYPAL_API_HTTP_ERROR",
      message: "The specified resource does not exist.",
    });
  });

  it("refuses tools it can't answer", async () => {
    const { direct } = fakePayPal();
    await assert.rejects(direct.read("cancel_sent_invoice", { invoice_id: "INV2-AAAA" }), /can't be answered from REST/);
  });
});
