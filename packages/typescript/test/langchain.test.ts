import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { StructuredTool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HandrailAgentToolkit } from "../handrail-langchain/src/index.js";
import { REFUNDS, refund, startHandrail, status } from "./handrail.js";

/** A chat model that plays back a script, standing in for OpenAI in PayPal's example. */
class ScriptedChatModel extends BaseChatModel {
  constructor(private readonly script: AIMessage[]) {
    super({});
  }
  _llmType() {
    return "scripted";
  }
  bindTools() {
    return this as any;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.script.shift() ?? new AIMessage("done");
    return { generations: [{ message, text: String(message.content) }] };
  }
}

describe("handrail-langchain", () => {
  it("offers StructuredTools for the configured tools, like PayPal's toolkit", async () => {
    const h = await startHandrail();
    const tools = new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).getTools();
    assert.deepEqual(tools.map((t) => t.name), ["create_refund", "handrail_get_approval"]);
    assert.ok(tools.every((t) => t instanceof StructuredTool));
  });

  it("an allowed refund and a held one", async () => {
    const h = await startHandrail();
    const [createRefund] = new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).getTools();
    assert.equal(status(await createRefund!.invoke(refund("5.00"))), "COMPLETED");
    assert.equal(status(await createRefund!.invoke(refund("150.00"))), "pending_approval");
    assert.equal(h.paypal.length, 1);
    await assert.rejects(createRefund!.invoke({ amount: { currency_code: "USD", value: "5.00" } } as any), /capture_id|schema/i);
    assert.equal(h.callLog.recent(10).length, 2, "the invalid call never reached Handrail");
  });

  it("runs in PayPal's example agent (createReactAgent), with tool calls going through Handrail", async () => {
    const h = await startHandrail();
    const tools = new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).getTools();
    const llm = new ScriptedChatModel([
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "create_refund", args: refund("5.00") }] }),
      new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "create_refund", args: refund("150.00") }] }),
      new AIMessage("The $5.00 refund went through; the $150.00 one is waiting for approval."),
    ]);
    const agent = createReactAgent({ llm, tools });
    const result = await agent.invoke({ messages: [{ role: "user", content: "Refund $5 then $150." }] });
    const toolOutputs = result.messages.filter((m: BaseMessage) => m.getType() === "tool").map((m: BaseMessage) => status(String(m.content)));
    assert.deepEqual(toolOutputs, ["COMPLETED", "pending_approval"]);
    assert.match(String(result.messages.at(-1)!.content), /waiting for approval/);
  });
});
