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
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      method: init.method ?? "GET",
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(data), { status });
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
