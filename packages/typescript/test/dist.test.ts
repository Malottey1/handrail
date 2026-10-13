// The built packages (dist/, what an install gets) work, in both module formats.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { REFUNDS, refund, startHandrail, status } from "./handrail.js";

const require = createRequire(import.meta.url);

describe("built packages", () => {
  it("handrail-ai-sdk and handrail-langchain from dist (ESM and CommonJS)", async () => {
    const h = await startHandrail();
    const aiEsm = await import("../handrail-ai-sdk/dist/index.js");
    const lcEsm = await import("../handrail-langchain/dist/index.js");
    const aiCjs = require("../handrail-ai-sdk/dist/index.cjs");
    const lcCjs = require("../handrail-langchain/dist/index.cjs");
    // Distinct idempotency keys: otherwise Handrail rightly treats the second refund as a retry of the first.
    for (const [i, mod] of [aiEsm, aiCjs].entries()) {
      const tools = new mod.HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).getTools();
      const args = { ...refund("5.00"), idempotency_key: `dist-${i}` };
      assert.equal(status(await tools.create_refund.execute(args, { toolCallId: "1", messages: [] })), "COMPLETED");
      assert.ok(mod.ALL_TOOLS_ENABLED.payments.createRefund);
    }
    for (const [i, mod] of [lcEsm, lcCjs].entries()) {
      const [t] = new mod.HandrailAgentToolkit({ url: h.url, agentKey: h.agentKey, configuration: REFUNDS }).getTools();
      assert.equal(status(await t.invoke({ ...refund("150.00"), idempotency_key: `dist-held-${i}` })), "pending_approval");
    }
  });
});
