/**
 * PayPal's Agent Toolkit tools for the Vercel AI SDK, with every call going
 * through Handrail. A drop-in for `@paypal/agent-toolkit/ai-sdk`: the same
 * `configuration`, `getTools()` and `ALL_TOOLS_ENABLED`, but the constructor
 * takes Handrail's URL and an agent key instead of PayPal credentials.
 */
import { tool, type Tool } from "ai";
import { setUp, runTool, type HandrailToolkitOptions } from "../../core/toolkit.js";
import type { HandrailClient } from "../../core/client.js";

export class HandrailAgentToolkit {
  readonly client: HandrailClient;
  private readonly _tools: { [name: string]: Tool };

  constructor(options: HandrailToolkitOptions) {
    const { client, specs } = setUp(options);
    this.client = client;
    this._tools = Object.fromEntries(
      specs.map((spec) => [spec.name, tool({ description: spec.description, parameters: spec.schema, execute: (args) => runTool(client, spec.name, args) })]),
    );
  }

  getTools(): { [name: string]: Tool } {
    return this._tools;
  }
}

export { HandrailWorkflows } from "./workflows.js";
export { ALL_TOOLS_ENABLED, HandrailClient, HandrailError, GET_APPROVAL_TOOL, isToolAllowed, resultJson } from "../../core/toolkit.js";
export type { Configuration, HandrailToolkitOptions } from "../../core/toolkit.js";
