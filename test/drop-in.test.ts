import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Gate } from "../src/gate.js";
import { createProxyServer, SERVER_INFO } from "../src/proxy.js";
import { compareServers, snapshotServer, type ServerSnapshot } from "../src/tool-parity.js";

/** PayPal's sandbox MCP server as an agent sees it. Refresh with `npm run check:drop-in -- --update`. */
const PAYPAL: ServerSnapshot = JSON.parse(readFileSync("test/fixtures/paypal-mcp-server.json", "utf8"));

async function connect(server: Server): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

/** A stand-in for PayPal's server that serves the recorded listing. */
function fakePayPal(snapshot: ServerSnapshot): Server {
  const server = new Server(snapshot.serverInfo!, {
    capabilities: snapshot.capabilities!,
    ...(snapshot.instructions ? { instructions: snapshot.instructions } : {}),
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: snapshot.tools }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: snapshot.resources }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, mimeType: "text/plain", text: `contents of ${req.params.uri}` }],
  }));
  return server;
}

/** What an agent sees from PayPal directly, and through Handrail. Listing never reaches the gate. */
async function bothSides() {
  const upstream = await connect(fakePayPal(PAYPAL));
  const direct = await snapshotServer(upstream);
  const agent = await connect(createProxyServer(upstream, {} as Gate));
  return { direct, agent, viaHandrail: await snapshotServer(agent) };
}

describe("drop-in compatibility with PayPal's MCP server", () => {
  it("the fixture is a full listing of PayPal's server", () => {
    assert.equal(PAYPAL.serverInfo?.name, "PayPal MCP Agent");
    assert.equal(PAYPAL.tools.length, 46);
    for (const name of ["create_refund", "accept_dispute_claim", "pay_order", "cancel_sent_invoice", "cancel_subscription"]) {
      assert.ok(PAYPAL.tools.some((t) => t.name === name), name);
    }
  });

  it("identifies as Handrail, never as PayPal", async () => {
    const { viaHandrail } = await bothSides();
    assert.deepEqual(viaHandrail.serverInfo, SERVER_INFO);
    assert.equal(SERVER_INFO.name, "handrail");
    assert.equal(SERVER_INFO.version, JSON.parse(readFileSync("package.json", "utf8")).version);
  });

  it("presents the same capabilities, resources, tool names, descriptions and schemas", async () => {
    const { direct, viaHandrail } = await bothSides();
    assert.deepEqual(compareServers(direct, viaHandrail), []);
    // Also against the raw fixture, so a change to the fake can't hide a gap.
    assert.deepEqual(compareServers(PAYPAL, viaHandrail), []);
  });

  it("only adds the documented extras", async () => {
    const { viaHandrail } = await bothSides();
    const ours = new Map(viaHandrail.tools.map((t) => [t.name, t]));
    assert.equal(viaHandrail.tools.length, PAYPAL.tools.length + 1);
    assert.ok(ours.has("handrail_get_approval"));
    const refund = ours.get("create_refund")!;
    assert.ok(refund.inputSchema.properties?.idempotency_key);
    assert.ok(!refund.inputSchema.required?.includes("idempotency_key"));
    assert.equal(ours.get("list_transactions")!.inputSchema.properties?.idempotency_key, undefined);
  });

  it("passes resource reads through to PayPal", async () => {
    const { agent } = await bothSides();
    const uri = PAYPAL.resources[0]!.uri;
    const read = await agent.readResource({ uri });
    assert.deepEqual(read.contents, [{ uri, mimeType: "text/plain", text: `contents of ${uri}` }]);
  });

  it("the comparison catches any other difference", async () => {
    const { viaHandrail } = await bothSides();
    const edit = (f: (s: ServerSnapshot) => void) => {
      const copy: ServerSnapshot = structuredClone(viaHandrail);
      f(copy);
      return compareServers(PAYPAL, copy);
    };
    const tool = (s: ServerSnapshot, name: string) => s.tools.find((t) => t.name === name)!;

    assert.match(edit((s) => (tool(s, "create_refund").description += " ")).join(), /create_refund: description differs/);
    assert.match(edit((s) => (tool(s, "accept_dispute_claim").inputSchema.required = [])).join(), /accept_dispute_claim: inputSchema differs/);
    assert.match(edit((s) => (s.tools = s.tools.filter((t) => t.name !== "pay_order"))).join(), /pay_order: missing/);
    assert.match(edit((s) => s.tools.push({ ...tool(s, "create_refund"), name: "bonus_tool" })).join(), /bonus_tool: extra tool/);
    assert.match(edit((s) => tool(s, "create_refund").inputSchema.required!.push("idempotency_key")).join(), /must stay optional/);
    assert.deepEqual(edit((s) => (s.serverInfo = { name: "handrail", version: "9.9.9" })), []);
    assert.match(edit((s) => (s.serverInfo = PAYPAL.serverInfo)).join(), /claims to be the upstream server/);
    assert.match(edit((s) => (s.capabilities = { tools: {} })).join(), /capabilities/);
    assert.match(edit((s) => s.tools.reverse()).join(), /different order/);
  });

  it("treats PayPal's clock-based defaults as equal", async () => {
    const { viaHandrail } = await bothSides();
    const later: ServerSnapshot = structuredClone(viaHandrail);
    const props = later.tools.find((t) => t.name === "list_transactions")!.inputSchema.properties as Record<string, { default?: unknown }>;
    props.end_date!.default = "2030-01-01T00:00:00.000Z";
    assert.deepEqual(compareServers(PAYPAL, later), []);
    props.end_date!.default = "yesterday";
    assert.match(compareServers(PAYPAL, later).join(), /list_transactions: inputSchema differs/);
  });
});
