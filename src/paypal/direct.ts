import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PayPalTokenManager } from "./auth.js";

const TIMEOUT_MS = 30_000;

/**
 * Tools Handrail sends straight to PayPal's REST API instead of through the MCP
 * server, so each call can carry its own PayPal-Request-Id. (The Agent Toolkit
 * sets that header once per client, never per call: agent-toolkit
 * typescript/src/shared/client.ts.) The request bodies and result format match
 * the toolkit's createRefund and captureOrder, so the agent sees the same output.
 */
export const DIRECT_TOOLS = new Set(["create_refund", "pay_order"]);

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
      default:
        throw new Error(`${tool} is not a direct tool`);
    }
  }

  /** Returns PayPal's JSON on 2xx, the toolkit's error shape on an HTTP error; throws NoResponseError otherwise. */
  private async post(path: string, body: unknown, requestId: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.tokens.getToken()}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": requestId,
          Prefer: "return=representation",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new NoResponseError(`No response from PayPal: ${(err as Error).message}`);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return data;
    return { ok: false, status: res.status, code: "PAYPAL_API_HTTP_ERROR", message: describeError(data) };
  }
}

function describeError(data: Record<string, unknown>): string {
  const base = String(data.message ?? data.error_description ?? data.name ?? "Unknown error");
  const details = Array.isArray(data.details)
    ? data.details.map((d: { description?: string; issue?: string }) => d?.description || d?.issue || "").filter(Boolean).join("; ")
    : "";
  return (details ? `${base}: ${details}` : base).slice(0, 300);
}

function text(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
