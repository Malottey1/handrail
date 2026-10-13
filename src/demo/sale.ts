import { randomUUID } from "node:crypto";
import type { PayPalTokenManager } from "../paypal/auth.js";

export interface DemoSale {
  orderId: string;
  captureId: string;
}

/** PayPal's generic sandbox Visa number; sandbox only (config refuses live URLs). */
const SANDBOX_CARD = { number: "4111111111111111", expiry: "2030-12", name: "Demo Buyer", security_code: "123" };

/**
 * Makes a real sandbox sale for the demo agent to refund: an order paid by a
 * sandbox test card, captured in one step, so no buyer has to approve it in a
 * browser. This is the shop taking a payment, not the agent acting, so it goes
 * straight to PayPal's REST API rather than through the gate.
 */
export async function createDemoSale(baseUrl: string, tokens: PayPalTokenManager, amount: string): Promise<DemoSale> {
  const res = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await tokens.getToken()}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(),
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: amount }, description: "Handrail demo sale", custom_id: "handrail-demo" }],
      payment_source: { card: SANDBOX_CARD },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const order = (await res.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    message?: string;
    purchase_units?: Array<{ payments?: { captures?: Array<{ id?: string; status?: string }> } }>;
  };
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!res.ok || !order.id || !capture?.id || capture.status !== "COMPLETED") {
    throw new Error(`PayPal didn't complete the demo sale (HTTP ${res.status}${order.message ? `: ${order.message}` : ""})`);
  }
  return { orderId: order.id, captureId: capture.id };
}
