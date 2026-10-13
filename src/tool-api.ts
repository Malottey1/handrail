import type { IncomingMessage, ServerResponse } from "node:http";
import { callAgentTool, listAgentTools } from "./agent-tools.js";
import { log } from "./log.js";
import { NO_AGENT_KEY, resolveAgent, type McpEndpointDeps } from "./mcp-endpoint.js";
import { redact } from "./redact.js";

const MAX_BODY_BYTES = 1024 * 1024;

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));

class BadRequest extends Error {}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest("Body too large (1 MB max)");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new BadRequest("Body must be JSON");
  }
}

/**
 * The tool-call API: the same tools and the same handling as MCP, over plain
 * HTTP, for agent frameworks that don't speak MCP (and the Handrail wrapper
 * packages in packages/). Authenticated with an agent key, like /mcp.
 *
 *   GET  /v1/tools        -> { tools }   (MCP tools/list, every page)
 *   POST /v1/tools/call   { name, arguments } -> the MCP CallToolResult
 *
 * Results are exactly what an MCP client gets, including Handrail's
 * pending_approval / blocked / duplicate answers and handrail_get_approval.
 * Returns false for paths it doesn't handle.
 */
export async function handleToolApi(req: IncomingMessage, res: ServerResponse, deps: McpEndpointDeps): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path !== "/v1/tools" && path !== "/v1/tools/call") return false;

  const expected = path === "/v1/tools" ? "GET" : "POST";
  if (req.method !== expected) {
    json(res, 405, { error: `Use ${expected} ${path}` }, { Allow: expected });
    return true;
  }
  const resolved = resolveAgent(req, deps);
  if (!resolved) {
    json(res, 401, { error: NO_AGENT_KEY }, { "WWW-Authenticate": "Bearer" });
    return true;
  }

  try {
    if (path === "/v1/tools") {
      json(res, 200, { tools: await listAgentTools(deps.upstream) });
      return true;
    }
    const body = (await readBody(req)) as { name?: unknown; arguments?: unknown } | null;
    if (!body || typeof body !== "object" || typeof body.name !== "string" || !body.name) {
      throw new BadRequest('Send { "name": "<tool>", "arguments": { ... } }');
    }
    const args = body.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new BadRequest("arguments must be an object");
    json(res, 200, await callAgentTool(resolved.gate, body.name, args as Record<string, unknown>, resolved.agent));
  } catch (err) {
    if (err instanceof BadRequest) {
      json(res, 400, { error: err.message });
    } else {
      // Same as MCP: the detail goes to the log, not the client.
      log("Tool API request failed:", redact((err as Error).message));
      json(res, 502, { error: "Handrail couldn't complete this request. Try again." });
    }
  }
  return true;
}
