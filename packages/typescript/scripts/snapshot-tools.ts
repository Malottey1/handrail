// Writes core/tools.json: the tools Handrail offers agents (PayPal's MCP tool list,
// as recorded in test/fixtures/paypal-mcp-server.json, with Handrail's additions).
// The wrappers ship this so their constructors can be synchronous, like PayPal's.
// test/snapshot.test.ts fails if it drifts from what Handrail would serve.
//   npm run snapshot   (after `npm run check:drop-in -- --update` in the repo root)
import { readFileSync, writeFileSync } from "node:fs";
import { withHandrailAdditions } from "../../../src/agent-tools.js";

const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/paypal-mcp-server.json", import.meta.url), "utf8"));
const { tools } = withHandrailAdditions({ tools: fixture.tools });
const slim = tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
writeFileSync(new URL("../core/tools.json", import.meta.url), JSON.stringify(slim, null, 2) + "\n");
console.log(`core/tools.json: ${slim.length} tools`);
