/**
 * A small client for Handrail's tool-call API (GET /v1/tools, POST /v1/tools/call).
 * It holds an agent key and nothing else: never PayPal credentials, and it
 * never calls PayPal. Every call goes through Handrail's policy, approvals,
 * idempotency, audit log and alerts.
 */

/** A held call waits about 20 seconds inline for a person before Handrail answers. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export class HandrailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HandrailError";
  }
}

export type CallToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

export class HandrailClient {
  readonly url: string;
  readonly #agentKey: string;
  readonly timeoutMs: number;

  constructor({ url, agentKey, timeoutMs = DEFAULT_TIMEOUT_MS }: { url: string; agentKey: string; timeoutMs?: number }) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Handrail URL must look like https://handrail.example.com, got ${JSON.stringify(url)}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Handrail URL must be http or https");
    if (!agentKey) throw new Error("An agent key is required. Create one in Handrail's dashboard (Team & keys).");
    this.url = url.replace(/\/+$/, "");
    this.#agentKey = agentKey;
    this.timeoutMs = timeoutMs;
  }

  toJSON() {
    return { url: this.url }; // never the key
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#agentKey}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError") throw new HandrailError(`Handrail at ${this.url} didn't answer within ${this.timeoutMs / 1000} seconds`);
      throw new HandrailError(`Couldn't reach Handrail at ${this.url}: ${(e.cause as Error)?.message ?? e.message}`);
    }
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 401) throw new HandrailError(`Handrail refused the agent key: ${data?.error ?? "missing, unknown or revoked"}`, 401);
    if (!res.ok) throw new HandrailError(`Handrail answered HTTP ${res.status}${data?.error ? `: ${data.error}` : ""}`, res.status);
    return data;
  }

  /** Every tool, with the same names and JSON Schemas an MCP client sees. */
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> {
    return (await this.request("GET", "/v1/tools")).tools;
  }

  /**
   * The MCP CallToolResult. A held, blocked or duplicate call is a normal result
   * whose text is Handrail's JSON, e.g. {"handrail": {"status": "pending_approval", ...}}.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return this.request("POST", "/v1/tools/call", { name, arguments: args });
  }

  /** The result as text, the way PayPal's toolkit returns it to the agent. */
  async run(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.callTool(name, args);
    return (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  }
}
