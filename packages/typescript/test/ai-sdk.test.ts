import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { ALL_TOOLS_ENABLED, HandrailAgentToolkit } from "../handrail-ai-sdk/src/index.js";
import { REFUNDS, refund, startHandrail, status } from "./handrail.js";

const run = (t: any, args: unknown) => t.execute(args, { toolCallId: "1", messages: [] });

describe("handrail-ai-sdk", () => {
  it("offers the configured tools, like PayPal's toolkit", async () => {
    const h = await startHandrail();
    assert.deepEqual(Object.keys(new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).getTools()), ["create_refund", "handrail_get_approval"]);
    assert.equal(Object.keys(new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: { actions: ALL_TOOLS_ENABLED } }).getTools()).length, 47);
  });

  it("an allowed refund reaches PayPal; a held one doesn't, and the agent is told", async () => {
    const h = await startHandrail();
    const tools = new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).getTools();
    assert.equal(status(await run(tools.create_refund, refund("5.00"))), "COMPLETED");
    assert.equal(status(await run(tools.create_refund, refund("150.00"))), "pending_approval");
    assert.deepEqual(h.paypal.map((c) => (c.args.amount as { value: string }).value), ["5.00"]);
    assert.deepEqual(h.callLog.recent(10).map((r) => [r.decision, r.agent_name]).reverse(), [["allow", "Support bot"], ["require_approval", "Support bot"]]);
    assert.equal(h.approvals.list("pending").length, 1);
  });

  it("works inside generateText: the model's tool calls go through Handrail", async () => {
    const h = await startHandrail();
    const tools = new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).getTools();
    let step = 0;
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        step++;
        const usage = { promptTokens: 1, completionTokens: 1 };
        if (step <= 2) {
          const args = JSON.stringify(refund(step === 1 ? "5.00" : "150.00"));
          return { rawCall: { rawPrompt: null, rawSettings: {} }, finishReason: "tool-calls", usage, toolCalls: [{ toolCallType: "function", toolCallId: `c${step}`, toolName: "create_refund", args }] };
        }
        return { rawCall: { rawPrompt: null, rawSettings: {} }, finishReason: "stop", usage, text: "The $5.00 refund went through; the $150.00 one is waiting for approval." };
      },
    });
    const { text, steps } = await generateText({ model, tools, maxSteps: 5, prompt: "Refund $5 then $150." });
    assert.match(text, /waiting for approval/);
    const results = steps.flatMap((s) => (s.toolResults as Array<{ result: unknown }>).map((r) => status(r.result as string)));
    assert.deepEqual(results, ["COMPLETED", "pending_approval"]);
    assert.equal(h.paypal.length, 1);
  });

  it("invalid arguments are rejected before anything reaches Handrail", async () => {
    const h = await startHandrail();
    const tools = new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).getTools();
    const parsed = (tools.create_refund.parameters as any).safeParse({ amount: { currency_code: "USD", value: "5.00" } });
    assert.equal(parsed.success, false, "capture_id is required");
    assert.equal(h.callLog.recent(10).length, 0);
  });

  it("never takes PayPal credentials; key problems come back as text for the agent", async () => {
    const h = await startHandrail();
    assert.throws(() => new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: { ...REFUNDS, context: { access_token: "A21AA" + "x".repeat(30) } } }), /access token/);
    assert.throws(() => new HandrailAgentToolkit({ url: h.url, agentKey: "", configuration: REFUNDS }), /agent key/);
    const wrong = new HandrailAgentToolkit({ url: h.url, agentKey: "wrong", configuration: REFUNDS }).getTools();
    assert.match(await run(wrong.create_refund, refund("5.00")), /Error calling 'create_refund' through Handrail: Handrail refused the agent key/);
    assert.equal(JSON.stringify(new HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).client).includes(h.agentKey), false);
  });
});
