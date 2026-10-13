/**
 * PayPal's Agent Toolkit tools for LangChain JS, with every call going through
 * Handrail. A drop-in for `@paypal/agent-toolkit/langchain`: the same
 * `configuration`, `getTools()` and `ALL_TOOLS_ENABLED`, but the constructor
 * takes Handrail's URL and an agent key instead of PayPal credentials.
 */
import { StructuredTool, type BaseToolkit } from "@langchain/core/tools";
import type { z } from "zod";
import { setUp, runTool, type HandrailToolkitOptions } from "../../core/toolkit.js";
import type { HandrailClient } from "../../core/client.js";

export class HandrailTool extends StructuredTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  readonly method: string;
  private readonly handrail: HandrailClient;

  constructor(handrail: HandrailClient, method: string, description: string, schema: z.ZodObject<z.ZodRawShape>) {
    super();
    this.handrail = handrail;
    this.method = method;
    this.name = method;
    this.description = description;
    this.schema = schema;
  }

  protected _call(arg: Record<string, unknown>): Promise<string> {
    return runTool(this.handrail, this.method, arg);
  }
}

export class HandrailAgentToolkit implements BaseToolkit {
  readonly client: HandrailClient;
  tools: HandrailTool[];

  constructor(options: HandrailToolkitOptions) {
    const { client, specs } = setUp(options);
    this.client = client;
    this.tools = specs.map((spec) => new HandrailTool(client, spec.name, spec.description, spec.schema));
  }

  getTools(): HandrailTool[] {
    return this.tools;
  }
}

export { ALL_TOOLS_ENABLED, HandrailClient, HandrailError, GET_APPROVAL_TOOL, isToolAllowed } from "../../core/toolkit.js";
export type { Configuration, HandrailToolkitOptions } from "../../core/toolkit.js";
