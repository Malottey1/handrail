import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GET_APPROVAL_TOOL, type Gate } from "./gate.js";
import { IDEMPOTENCY_ARG } from "./idempotency.js";
import { classifyTool } from "./policy/classify.js";

const IDEMPOTENCY_PROPERTY = {
  type: "string",
  description:
    "Optional. Calls with the same key are one operation: Handrail never executes it twice. " +
    "Without a key, identical calls within an hour are treated as retries of one operation.",
};

/**
 * Builds the agent-facing MCP server. It exposes PayPal's tools, with an
 * optional idempotency_key on every non-read tool, plus handrail_get_approval,
 * and sends every call through the gate.
 */
export function createProxyServer(upstream: Client, gate: Gate): Server {
  const server = new Server({ name: "handrail", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await upstream.listTools(request.params);
    const tools = result.tools.map((tool) =>
      classifyTool(tool.name) === "read"
        ? tool
        : { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, [IDEMPOTENCY_ARG]: IDEMPOTENCY_PROPERTY } } },
    );
    return { ...result, tools: [...tools, GET_APPROVAL_TOOL] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return gate.handle(request.params.name, request.params.arguments ?? {});
  });

  return server;
}
