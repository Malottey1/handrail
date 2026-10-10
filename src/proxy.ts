import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallLog } from "./audit.js";
import { log } from "./log.js";

/**
 * Builds the agent-facing MCP server. It exposes PayPal's tools unchanged and
 * forwards each call upstream, logging tool, arguments, result and timing.
 */
export function createProxyServer(upstream: Client, callLog: CallLog): Server {
  const server = new Server({ name: "handrail", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return upstream.listTools(request.params);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const started = performance.now();
    let result: CallToolResult;

    try {
      result = (await upstream.callTool(request.params)) as CallToolResult;
    } catch (err) {
      // Surface upstream failures to the agent as a tool error, not a protocol error.
      result = {
        content: [{ type: "text", text: `Upstream PayPal MCP error: ${(err as Error).message}` }],
        isError: true,
      };
    }

    const durationMs = performance.now() - started;
    const isError = result.isError === true;
    callLog.record({ tool: name, args, result, isError, durationMs });
    log(`${name} ${isError ? "ERROR" : "ok"} ${Math.round(durationMs)}ms args=${JSON.stringify(args ?? {})}`);

    return result;
  });

  return server;
}
