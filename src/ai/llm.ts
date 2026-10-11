import Anthropic from "@anthropic-ai/sdk";

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

export class AnthropicLlm implements Llm {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 2 });
  }

  /** Forces a single tool call whose input is the answer, so the reply is always JSON. */
  async json(request: Parameters<Llm["json"]>[0]): Promise<unknown> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 2000,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      tools: [{ name: request.name, description: request.description, input_schema: request.schema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "tool", name: request.name },
    });
    const call = message.content.find((block) => block.type === "tool_use");
    if (!call) throw new Error(`Model returned no ${request.name} answer (stop reason ${message.stop_reason})`);
    return call.input;
  }
}
