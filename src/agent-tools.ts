import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, ListToolsResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentIdentity } from "./auth/agent-keys.js";
import { GET_APPROVAL_TOOL, type Gate } from "./gate.js";
import { IDEMPOTENCY_ARG } from "./idempotency.js";
import { classifyTool } from "./policy/classify.js";

/**
 * What agents see and call, whichever way they connect: MCP (/mcp, stdio) or
 * the REST tool-call API (/v1/tools). Both use these two functions, so the
 * tool list and every call's handling can't drift between them.
 */

const IDEMPOTENCY_PROPERTY = {
  type: "string",
  description:
    "Optional. Calls with the same key are one operation: Handrail never executes it twice. " +
    "Without a key, identical calls within an hour are treated as retries of one operation.",
};

/**
 * One page of PayPal's tool list as Handrail offers it: the same tools, with
 * an optional idempotency_key on every non-read tool and handrail_get_approval
 * added (see src/tool-parity.ts).
 */
export function withHandrailAdditions(page: ListToolsResult): ListToolsResult {
  const tools = page.tools.map((tool) =>
    classifyTool(tool.name) === "read"
      ? tool
      : { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, [IDEMPOTENCY_ARG]: IDEMPOTENCY_PROPERTY } } },
  );
  // handrail_get_approval goes on the last page only, so a paginated listing names it once.
  return { ...page, tools: page.nextCursor ? tools : [...tools, GET_APPROVAL_TOOL] };
}

/** Every tool, all pages (for the REST API, which doesn't paginate). */
export async function listAgentTools(upstream: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = withHandrailAdditions(await upstream.listTools(cursor ? { cursor } : undefined));
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** One tool call from an agent: through the gate (policy, approval, idempotency, audit, alerts). */
export function callAgentTool(gate: Gate, name: string, args: Record<string, unknown>, agent: AgentIdentity | null): Promise<CallToolResult> {
  return gate.handle(name, args, agent);
}
