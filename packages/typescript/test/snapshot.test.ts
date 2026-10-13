import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listAgentTools } from "../../../src/agent-tools.js";
import { ALL_TOOLS_ENABLED, TOOL_ACTIONS } from "../core/actions.js";
import { isToolAllowed } from "../core/toolkit.js";
import TOOLS from "../core/tools.json" with { type: "json" };
import { fakeUpstream } from "./handrail.js";

describe("the bundled tool list", () => {
  it("is exactly what Handrail serves (run `npm run snapshot` if PayPal's tools changed)", async () => {
    const served = (await listAgentTools(fakeUpstream)).map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
    assert.deepEqual(TOOLS, served);
  });

  it("every tool has PayPal's action names, and ALL_TOOLS_ENABLED enables all of them", () => {
    for (const t of TOOLS) {
      if (t.name !== "handrail_get_approval") assert.ok(TOOL_ACTIONS[t.name], t.name);
      assert.ok(isToolAllowed(t.name, { actions: ALL_TOOLS_ENABLED }), t.name);
    }
    assert.ok(!isToolAllowed("create_refund", { actions: { orders: { create: true } } }));
  });
});
