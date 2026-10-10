import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GET_APPROVAL_TOOL, type Gate } from "./gate.js";

/**
 * Builds the agent-facing MCP server. It exposes PayPal's tools unchanged, plus
 * handrail_get_approval, and sends every call through the gate.
 */
export function createProxyServer(upstream: Client, gate: Gate): Server {
  const server = new Server({ name: "handrail", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await upstream.listTools(request.params);
    return { ...result, tools: [...result.tools, GET_APPROVAL_TOOL] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return gate.handle(request.params.name, request.params.arguments ?? {});
  });

  return server;
}
