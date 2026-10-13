import { z } from "zod";
import { TOOL_ACTIONS, type Actions } from "./actions.js";
import { HandrailClient, HandrailError } from "./client.js";
import { objectFromJsonSchema } from "./schema.js";
import TOOLS from "./tools.json" with { type: "json" };

export const GET_APPROVAL_TOOL = "handrail_get_approval";

/** Same shape as PayPal's Configuration. `context` is accepted and never sent: PayPal settings live in Handrail. */
export type Configuration = {
  actions: Actions;
  context?: { access_token?: string; [key: string]: unknown };
};

export type HandrailToolkitOptions = {
  /** Where Handrail runs, e.g. https://handrail.example.com */
  url: string;
  /** An agent key from Handrail's dashboard (Team & keys). Never PayPal credentials. */
  agentKey: string;
  configuration: Configuration;
  timeoutMs?: number;
};

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown>; schema: z.ZodObject<z.ZodRawShape> };

/** Same rule as PayPal's isToolAllowed: a tool is offered if any of its actions is enabled. */
export function isToolAllowed(name: string, configuration: Configuration): boolean {
  if (name === GET_APPROVAL_TOOL) return true; // checking a held call can't move money
  for (const [product, actions] of Object.entries(TOOL_ACTIONS[name] ?? {})) {
    for (const action of Object.keys(actions)) if (configuration.actions?.[product]?.[action]) return true;
  }
  return false;
}

/** The client and tool specs every wrapper starts from. Synchronous, like PayPal's constructors. */
export function setUp(options: HandrailToolkitOptions): { client: HandrailClient; specs: ToolSpec[] } {
  if (options.configuration?.context?.access_token) {
    throw new Error("Don't give the agent a PayPal access token: Handrail holds PayPal credentials. Use an agent key instead.");
  }
  const client = new HandrailClient({ url: options.url, agentKey: options.agentKey, timeoutMs: options.timeoutMs });
  const specs = (TOOLS as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>)
    .filter((t) => isToolAllowed(t.name, options.configuration))
    .map((t) => ({ ...t, description: t.description.trim() || t.name, schema: objectFromJsonSchema(t.inputSchema) }));
  return { client, specs };
}

/** Runs a tool through Handrail; Handrail's own errors come back as text for the agent, like PayPal's toolkit. */
export async function runTool(client: HandrailClient, name: string, args: unknown): Promise<string> {
  try {
    return await client.run(name, (args ?? {}) as Record<string, unknown>);
  } catch (err) {
    if (err instanceof HandrailError) return `Error calling '${name}' through Handrail: ${err.message}`;
    throw err;
  }
}

export { ALL_TOOLS_ENABLED } from "./actions.js";
export { HandrailClient, HandrailError } from "./client.js";
