import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Implementation, Resource, ServerCapabilities, Tool } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson, IDEMPOTENCY_ARG } from "./idempotency.js";
import { GET_APPROVAL_TOOL } from "./gate.js";
import { classifyTool } from "./policy/classify.js";

/**
 * What an MCP client can see of a server before calling anything. Handrail
 * must look the same as PayPal's server here, so an Agent Toolkit agent can
 * be pointed at it with no code changes.
 */
export interface ServerSnapshot {
  serverInfo: Implementation | null;
  capabilities: ServerCapabilities | null;
  instructions: string | null;
  tools: Tool[];
  resources: Resource[];
}

/**
 * The only differences Handrail adds, both optional for the agent: an
 * idempotency_key argument on non-read tools, and a tool to check a held call.
 */
export const HANDRAIL_ADDITIONS = {
  tools: [GET_APPROVAL_TOOL.name],
  argument: IDEMPOTENCY_ARG,
} as const;

export async function snapshotServer(client: Client): Promise<ServerSnapshot> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  const capabilities = client.getServerCapabilities() ?? null;
  const resources: Resource[] = [];
  if (capabilities?.resources) {
    cursor = undefined;
    do {
      const page = await client.listResources(cursor ? { cursor } : undefined);
      resources.push(...page.resources);
      cursor = page.nextCursor;
    } while (cursor);
  }

  return { serverInfo: client.getServerVersion() ?? null, capabilities, instructions: client.getInstructions() ?? null, tools, resources };
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * PayPal computes some defaults from the clock each time it lists tools
 * (list_transactions: start_date is 31 days ago, end_date is now), so two
 * listings a second apart differ. Compare those as "a timestamp".
 */
function withoutClockDefaults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutClockDefaults);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) =>
      k === "default" && typeof v === "string" && ISO_TIMESTAMP.test(v) ? [k, "<timestamp>"] : [k, withoutClockDefaults(v)],
    ),
  );
}

/** Our tool with Handrail's documented addition removed, for comparing against upstream's. */
function withoutAddition(tool: Tool): Tool {
  const { [HANDRAIL_ADDITIONS.argument]: _, ...properties } = tool.inputSchema.properties ?? {};
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

/** Every way `ours` differs from `upstream`, beyond HANDRAIL_ADDITIONS. Empty means drop-in. */
export function compareServers(upstream: ServerSnapshot, ours: ServerSnapshot): string[] {
  const problems: string[] = [];
  if (!same(upstream.serverInfo, ours.serverInfo)) {
    problems.push(`server info: upstream ${canonicalJson(upstream.serverInfo)}, Handrail ${canonicalJson(ours.serverInfo)}`);
  }
  if (!same(upstream.capabilities, ours.capabilities)) {
    problems.push(`capabilities: upstream ${canonicalJson(upstream.capabilities)}, Handrail ${canonicalJson(ours.capabilities)}`);
  }
  if (!same(upstream.instructions, ours.instructions)) problems.push("instructions differ");
  if (!same(upstream.resources, ours.resources)) problems.push("resources differ");

  const ourTools = new Map(ours.tools.map((t) => [t.name, t]));
  const upstreamNames = new Set(upstream.tools.map((t) => t.name));
  for (const tool of upstream.tools) {
    const mine = ourTools.get(tool.name);
    if (!mine) {
      problems.push(`${tool.name}: missing from Handrail`);
      continue;
    }
    const added = mine.inputSchema.properties?.[HANDRAIL_ADDITIONS.argument];
    if (classifyTool(tool.name) === "read" && added) problems.push(`${tool.name}: read tool has ${HANDRAIL_ADDITIONS.argument}`);
    if (classifyTool(tool.name) !== "read" && !added) problems.push(`${tool.name}: missing optional ${HANDRAIL_ADDITIONS.argument}`);
    if (mine.inputSchema.required?.includes(HANDRAIL_ADDITIONS.argument)) {
      problems.push(`${tool.name}: ${HANDRAIL_ADDITIONS.argument} must stay optional`);
    }
    const stripped = withoutAddition(mine);
    for (const key of new Set([...Object.keys(tool), ...Object.keys(stripped)]) as Set<keyof Tool>) {
      if (!same(withoutClockDefaults(tool[key]), withoutClockDefaults(stripped[key]))) problems.push(`${tool.name}: ${key} differs`);
    }
  }
  if (upstream.tools.map((t) => t.name).join() !== ours.tools.filter((t) => upstreamNames.has(t.name)).map((t) => t.name).join()) {
    problems.push("tools are listed in a different order");
  }
  for (const tool of ours.tools) {
    if (!upstreamNames.has(tool.name) && !(HANDRAIL_ADDITIONS.tools as readonly string[]).includes(tool.name)) {
      problems.push(`${tool.name}: extra tool not on the upstream server`);
    }
  }
  return problems;
}
