import Anthropic from "@anthropic-ai/sdk";
import { redact } from "../redact.js";

/**
 * The one way Handrail talks to a language model: ask for JSON matching a
 * schema. Callers must validate the result; the model's output is a proposal,
 * never trusted input. Faked in tests.
 */
export interface Llm {
  readonly model: string;
  json(request: {
    system: string;
    user: string;
    /** JSON Schema (an object) for the answer. */
    schema: Record<string, unknown>;
    /** Names the answer, e.g. "explain_held_call". */
    name: string;
    description: string;
    maxTokens?: number;
  }): Promise<unknown>;
}

const TIMEOUT_MS = 45_000;

/** Keywords structured outputs may reject. Callers validate with zod afterwards, so dropping them loses nothing. */
const DROPPED = new Set(["$schema", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "maxItems"]);

/**
 * Rewrites a JSON Schema into the subset structured outputs accepts: anyOf
 * instead of oneOf, closed objects, no length or range limits, minItems 0 or 1.
 */
export function structuredSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(structuredSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED.has(key)) continue;
    if (key === "minItems") {
      if (typeof value === "number" && value > 0) out.minItems = 1;
      continue;
    }
    // Under "properties" the keys are field names, not keywords.
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, structuredSchema(v)]));
      continue;
    }
    out[key === "oneOf" ? "anyOf" : key] = structuredSchema(value);
  }
  if (out.type === "object" || "properties" in out) out.additionalProperties = false;
  return out;
}

export class AnthropicLlm implements Llm {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 2 });
  }

  /** Structured outputs: the reply's text is JSON matching the schema. Prompts are redacted before they're sent. */
  async json(request: Parameters<Llm["json"]>[0]): Promise<unknown> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 2000,
      system: redact(`${request.system}\n\nAnswer with the ${request.name} JSON object: ${request.description}`),
      messages: [{ role: "user", content: redact(request.user) }],
      output_config: { format: { type: "json_schema", schema: structuredSchema(request.schema) as Record<string, unknown> } },
    });
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (message.stop_reason !== "end_turn" || !text) {
      throw new Error(`Model returned no ${request.name} answer (stop reason ${message.stop_reason})`);
    }
    return JSON.parse(text);
  }
}
