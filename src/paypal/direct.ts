import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PayPalTokenManager } from "./auth.js";

const TIMEOUT_MS = 30_000;

/**
 * Tools Handrail sends straight to PayPal's REST API instead of through the MCP
 * server, so each call can carry its own PayPal-Request-Id. (The Agent Toolkit
 * sets that header once per client, never per call: agent-toolkit
 * typescript/src/shared/client.ts.) The request bodies and result format match
 * the toolkit's createRefund, captureOrder and acceptDisputeClaim, so the agent
 * sees the same output.
 */
export const DIRECT_TOOLS = new Set(["create_refund", "pay_order", "accept_dispute_claim"]);

/**
 * Read tools Handrail can answer from the REST API when PayPal's MCP server
 * fails before sending anything (PAYPAL_API_SETUP_ERROR; paypal/AI-Toolkit
 * issue #34). Same requests as the toolkit's functions.ts, same result format.
 */
export const REST_READ_TOOLS = new Set(["list_disputes", "get_dispute", "list_products", "show_product_details", "list_invoices", "get_invoice"]);

/**
 * Guarded write tools Handrail sends to the REST API, with the operation's
 * PayPal-Request-Id, only when PayPal's MCP server fails before sending
 * (PAYPAL_API_SETUP_ERROR). Same requests and results as the toolkit's
 * sendInvoice, cancelSentInvoice and cancelSubscription.
 */
export const REST_WRITE_FALLBACK_TOOLS = new Set(["send_invoice", "cancel_sent_invoice", "cancel_subscription"]);

/** Thrown when PayPal gave no answer: the action may or may not have happened. */
export class NoResponseError extends Error {}

export class PayPalDirect {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: PayPalTokenManager,
  ) {}

  async call(tool: string, args: Record<string, unknown>, requestId: string): Promise<CallToolResult> {
    switch (tool) {
      case "create_refund": {
        const { capture_id, ...body } = args;
        const data = await this.post(`/v2/payments/captures/${encodeURIComponent(String(capture_id))}/refund`, body, requestId);
        return text(data);
      }
      case "pay_order": {
        const data = await this.post(`/v2/checkout/orders/${encodeURIComponent(String(args.id))}/capture`, {}, requestId);
        return "ok" in data ? text(data) : text({ status: "success", response: data });
      }
      case "accept_dispute_claim": {
        const data = await this.post(`/v1/customer/disputes/${encodeURIComponent(String(args.dispute_id))}/accept-claim`, { note: args.note }, requestId);
        return text(data);
      }
      // The toolkit posts all of send_invoice's and cancel_sent_invoice's arguments as the body.
      case "send_invoice": {
        const { data } = await this.send("POST", `/v2/invoicing/invoices/${encodeURIComponent(String(args.invoice_id))}/send`, args, requestId);
        return text(data);
      }
      case "cancel_sent_invoice": {
        const { status, data } = await this.send("POST", `/v2/invoicing/invoices/${encodeURIComponent(String(args.invoice_id))}/cancel`, args, requestId);
        return text(status === 204 ? { success: true, invoice_id: args.invoice_id } : data);
      }
      case "cancel_subscription": {
        const { data } = await this.send("POST", `/v1/billing/subscriptions/${encodeURIComponent(String(args.subscription_id))}/cancel`, args.payload, requestId);
        return text(data);
      }
      default:
        throw new Error(`${tool} is not a direct tool`);
    }
  }

  /** Answers a read tool from the REST API (see REST_READ_TOOLS). */
  async read(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const id = (key: string) => encodeURIComponent(String(args[key]));
    switch (tool) {
      case "list_disputes":
        return text(await this.request("GET", `/v1/customer/disputes${query(args)}`));
      case "get_dispute":
        return text(await this.request("GET", `/v1/customer/disputes/${id("dispute_id")}`));
      case "list_products": {
        const { page = 1, page_size = 2, total_required = true } = args;
        return text(await this.request("GET", `/v1/catalogs/products${query({ page_size, page, total_required })}`));
      }
      case "show_product_details":
        return text(await this.request("GET", `/v1/catalogs/products/${id("product_id")}`));
      case "list_invoices":
        return text(await this.request("GET", `/v2/invoicing/invoices${query(args)}`));
      case "get_invoice":
        return text(await this.request("GET", `/v2/invoicing/invoices/${id("invoice_id")}`));
      default:
        throw new Error(`${tool} can't be answered from REST`);
    }
  }

  private post(path: string, body: unknown, requestId: string): Promise<Record<string, unknown>> {
    return this.request("POST", path, body, requestId);
  }

  /** Returns PayPal's JSON on 2xx, the toolkit's error shape on an HTTP error; throws NoResponseError otherwise. */
  private async request(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<Record<string, unknown>> {
    const { data } = await this.send(method, path, body, requestId);
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  }

  /** Like request, but keeps the status and an empty body as "" (what the toolkit's axios call returns). */
  private async send(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<{ status: number; data: unknown }> {
    let res: Response;
    let raw: string;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.tokens.getToken()}` };
      if (method === "POST") {
        headers["Content-Type"] = "application/json";
        headers.Prefer = "return=representation";
        if (requestId) headers["PayPal-Request-Id"] = requestId;
      }
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      raw = await res.text();
    } catch (err) {
      throw new NoResponseError(`No response from PayPal: ${(err as Error).message}`);
    }

    let data: unknown = "";
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }
    }
    if (res.ok) return { status: res.status, data };
    const fields = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    return { status: res.status, data: { ok: false, status: res.status, code: "PAYPAL_API_HTTP_ERROR", message: describeError(fields) } };
  }
}

function describeError(data: Record<string, unknown>): string {
  const base = String(data.message ?? data.error_description ?? data.name ?? "Unknown error");
  const details = Array.isArray(data.details)
    ? data.details.map((d: { description?: string; issue?: string }) => d?.description || d?.issue || "").filter(Boolean).join("; ")
    : "";
  return (details ? `${base}: ${details}` : base).slice(0, 300);
}

/** "?a=1&b=2" from the arguments that are set, like the toolkit's toQueryString; "" when none are. */
function query(args: Record<string, unknown>): string {
  const pairs = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

function text(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
