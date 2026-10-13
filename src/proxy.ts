import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentIdentity } from "./auth/agent-keys.js";
import { GET_APPROVAL_TOOL, type Gate } from "./gate.js";
import { IDEMPOTENCY_ARG } from "./idempotency.js";
import { classifyTool } from "./policy/classify.js";

const IDEMPOTENCY_PROPERTY = {
  type: "string",
  description:
    "Optional. Calls with the same key are one operation: Handrail never executes it twice. " +
    "Without a key, identical calls within an hour are treated as retries of one operation.",
};

/** How Handrail identifies itself to agents. It never claims to be PayPal. Keep in step with package.json. */
export const SERVER_INFO = { name: "handrail", version: "0.1.0" };

/**
 * Builds the agent-facing MCP server. It offers the upstream server's
 * capabilities, instructions, resources and tools, so an existing Agent
 * Toolkit agent works with no code changes. The only additions are an
 * optional idempotency_key on every non-read tool and handrail_get_approval
 * (see src/tool-parity.ts). Every tool call goes through the gate.
 */
/** `agent` is who is connected (an agent key, or the local stdio agent), recorded on every call. */
export function createProxyServer(upstream: Client, gate: Gate, agent: AgentIdentity | null = null): Server {
  const upstreamCaps = upstream.getServerCapabilities() ?? {};
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: upstreamCaps.tools ?? {},
      ...(upstreamCaps.resources ? { resources: upstreamCaps.resources } : {}),
    },
    instructions: upstream.getInstructions(),
  });

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
    return gate.handle(request.params.name, request.params.arguments ?? {}, agent);
  });

  // Read-only, so passed straight through.
  if (upstreamCaps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (request) => upstream.listResources(request.params));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => upstream.listResourceTemplates(request.params));
    server.setRequestHandler(ReadResourceRequestSchema, (request) => upstream.readResource(request.params));
  }

  return server;
}
