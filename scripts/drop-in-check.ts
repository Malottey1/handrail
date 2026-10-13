// Compares what an agent sees from PayPal's MCP server with what it sees from
// Handrail (server info, capabilities, resources, every tool's name,
// description and input schema). Lists only; never calls a tool.
// Run with: npm run check:drop-in [-- --update]  (--update refreshes the test fixture)
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import type { Gate } from "../src/gate.js";
import { PayPalTokenManager } from "../src/paypal/auth.js";
import { connectUpstream } from "../src/paypal/upstream.js";
import { createProxyServer } from "../src/proxy.js";
import { compareServers, HANDRAIL_ADDITIONS, snapshotServer } from "../src/tool-parity.js";

const FIXTURE = "test/fixtures/paypal-mcp-server.json";

const config = loadConfig();
const tokens = new PayPalTokenManager(config.paypalBaseUrl, config.paypalClientId, config.paypalClientSecret);
const upstream = await connectUpstream(config.paypalMcpUrl, tokens);
const theirs = await snapshotServer(upstream);

// Handrail's agent-facing server, in memory. Listing never reaches the gate.
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await createProxyServer(upstream, {} as Gate).connect(serverSide);
const agent = new Client({ name: "drop-in-check", version: "0.1.0" });
await agent.connect(clientSide);
const ours = await snapshotServer(agent);

if (process.argv.includes("--update")) {
  writeFileSync(FIXTURE, `${JSON.stringify(theirs, null, 2)}\n`);
  console.log(`Wrote ${FIXTURE}`);
}

const problems = compareServers(theirs, ours);
console.log(`${theirs.serverInfo?.name} ${theirs.serverInfo?.version}: ${theirs.tools.length} tools, ${theirs.resources.length} resources`);
console.log(`Handrail adds only: ${HANDRAIL_ADDITIONS.tools.join(", ")} and an optional ${HANDRAIL_ADDITIONS.argument} on non-read tools`);
if (problems.length) {
  console.log(`\n${problems.length} difference(s):`);
  for (const p of problems) console.log(`  - ${p}`);
} else {
  console.log("Drop-in: no other differences.");
}
await agent.close();
await upstream.close();
process.exit(problems.length ? 1 : 0);
