import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ENV_TOKEN_AGENT, type AgentIdentity, type AgentKeyStore } from "./auth/agent-keys.js";
import { bearer, safeEqual } from "./auth/http.js";
import type { Gate } from "./gate.js";
import { log } from "./log.js";
import { createProxyServer } from "./proxy.js";

export interface McpEndpointDeps {
  upstream: Client;
  gate: Gate;
  agentKeys: AgentKeyStore;
  /** Optional shared key from .env (HANDRAIL_AGENT_TOKEN), recorded as its own agent. */
  agentToken: string | undefined;
  /** Demo workspaces: their "Demo agent" keys reach their own gate, never the real one. */
  demo?: { authenticateAgent(secret: string): { agent: AgentIdentity; gate: Gate } | null } | null;
  now?: () => number;
}

/**
 * The agent behind a request's bearer key and the gate its calls go through
 * (a demo key reaches its own demo workspace), or null for a missing, unknown
 * or revoked key. Shared by /mcp and the REST tool-call API.
 */
export function resolveAgent(req: IncomingMessage, deps: Pick<McpEndpointDeps, "gate" | "agentKeys" | "agentToken" | "demo" | "now">): { agent: AgentIdentity; gate: Gate } | null {
  const real = authenticateAgent(req, deps);
  if (real) return { agent: real, gate: deps.gate };
  return deps.demo?.authenticateAgent(bearer(req) ?? "") ?? null;
}

export const NO_AGENT_KEY = "Missing, unknown or revoked agent key. Create one in the dashboard (Admin > Agent keys).";

/** The agent behind a request's bearer key, or null if the key is missing, unknown or revoked. */
export function authenticateAgent(req: IncomingMessage, deps: Pick<McpEndpointDeps, "agentKeys" | "agentToken" | "now">): AgentIdentity | null {
  const key = bearer(req);
  if (!key) return null;
  if (deps.agentToken && safeEqual(key, deps.agentToken)) return ENV_TOKEN_AGENT;
  return deps.agentKeys.authenticate(key, (deps.now ?? Date.now)());
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));

/**
 * POST /mcp: the agent-facing MCP endpoint over Streamable HTTP. It can move
 * money, so every request needs a valid agent key, even on localhost (a
 * tunnel for webhooks would otherwise expose it). The key's agent is
 * recorded on every call it makes.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, deps: McpEndpointDeps): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  const resolved = resolveAgent(req, deps);
  if (!resolved) {
    json(res, 401, { error: NO_AGENT_KEY }, { "WWW-Authenticate": "Bearer" });
    return;
  }
  const { agent, gate } = resolved;

  try {
    const body = await readJson(req);
    const server = createProxyServer(deps.upstream, gate, agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log("Request failed:", (err as Error).message);
    if (!res.headersSent) json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null });
  }
}
