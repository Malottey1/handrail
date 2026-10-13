import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalStore } from "../src/approvals.js";
import { AuditChain } from "../src/audit-chain.js";
import { CallLog } from "../src/audit.js";
import { AgentKeyStore } from "../src/auth/agent-keys.js";
import { Gate } from "../src/gate.js";
import { OperationStore } from "../src/idempotency.js";
import { handleMcp } from "../src/mcp-endpoint.js";
import type { PayPalRest } from "../src/paypal/rest.js";
import { parsePolicy } from "../src/policy/load.js";
import { handleToolApi } from "../src/tool-api.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const POLICY = parsePolicy({
  version: 1,
  defaults: { read: "allow", write: "allow", money: "allow", unknown: "require_approval" },
  rules: [
    { id: "approve-over-100", type: "amount_ceiling", tools: ["create_refund"], max: "100.00", currency: "USD", decision: "require_approval" },
    { id: "block-over-1000", type: "amount_ceiling", tools: ["create_refund"], max: "1000.00", currency: "USD", decision: "block" },
  ],
});

const TOOLS: Tool[] = [
  {
    name: "create_refund",
    description: "Refund a captured payment.",
    inputSchema: {
      type: "object",
      properties: { capture_id: { type: "string" }, amount: { type: "object", properties: { currency_code: { type: "string" }, value: { type: "string" } } } },
      required: ["capture_id"],
    },
  },
  { name: "list_transactions", description: "List transactions.", inputSchema: { type: "object", properties: { start_date: { type: "string" } } } },
];

/** A Handrail with a fake PayPal, serving /mcp and /v1/tools. */
async function world() {
  const db = new DatabaseSync(":memory:");
  const audit = new AuditChain(db);
  const callLog = new CallLog(db, audit);
  const approvals = new ApprovalStore(db, audit);
  const agentKeys = new AgentKeyStore(db, audit);
  audit.start(NOW);
  const { secret } = agentKeys.create("Support bot", { id: "u1", name: "Admin" }, NOW);
  const sent: Array<{ name: string; args: unknown }> = [];
  const answer = async (name: string, args: unknown): Promise<CallToolResult> => {
    sent.push({ name, args });
    return { content: [{ type: "text", text: JSON.stringify({ id: `PAYPAL-${sent.length}`, status: "COMPLETED" }) }] };
  };
  const upstream = {
    listTools: async () => ({ tools: TOOLS }),
    callTool: (p: { name: string; arguments?: unknown }) => answer(p.name, p.arguments),
    getServerCapabilities: () => ({ tools: {} }),
    getInstructions: () => "PayPal tools.",
  } as unknown as Client;
  const gate = new Gate(
    {
      upstream,
      rest: { get: async () => ({ id: "CAP1", amount: { currency_code: "USD", value: "2000.00" } }) } as unknown as PayPalRest,
      direct: { call: (name: string, args: Record<string, unknown>) => answer(name, args) },
      callLog,
      approvals,
      operations: new OperationStore(db, 3_600_000),
      policy: () => POLICY,
    },
    { approvalWaitMs: 0, now: () => NOW },
  );
  const deps = { upstream, gate, agentKeys, agentToken: undefined, now: () => NOW };
  const server = createServer(async (req, res) => {
    if (req.url === "/mcp") return handleMcp(req, res, deps);
    if (!(await handleToolApi(req, res, deps))) res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, base, secret, sent, agentKeys, gate };
}

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function mcpClient(base: string, key: string) {
  const client = new McpClient({ name: "test-agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

const rest = (base: string, key: string | null, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

/** Approval ids and agent keys are random per world; everything else must match exactly. */
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/apr_[a-f0-9]{20}/g, "apr_X").replace(/key_[a-f0-9]{16}/g, "key_X").replace(/hr_agent_[A-Za-z0-9_-]{6}/g, "hr_agent_X"));

/** The same agent session, as a list of calls. `approvalId` lets a later call refer to the held one. */
async function session(call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>) {
  const results: CallToolResult[] = [];
  results.push(await call("list_transactions", { start_date: "2026-10-01" })); // read: allowed
  results.push(await call("create_refund", { capture_id: "CAP1", amount: { currency_code: "USD", value: "5.00" }, idempotency_key: "a" })); // allowed
  const held = await call("create_refund", { capture_id: "CAP1", amount: { currency_code: "USD", value: "500.00" }, idempotency_key: "b" }); // held
  results.push(held);
  results.push(await call("create_refund", { capture_id: "CAP1", amount: { currency_code: "USD", value: "500.00" }, idempotency_key: "b" })); // retry: duplicate
  const approvalId = JSON.parse((held.content[0] as { text: string }).text).handrail.approval_id as string;
  results.push(await call("handrail_get_approval", { approval_id: approvalId }));
  results.push(await call("create_refund", { capture_id: "CAP1", amount: { currency_code: "USD", value: "5000.00" }, idempotency_key: "c" })); // blocked
  results.push(await call("not_a_paypal_tool", {})); // unknown: held (fails closed)
  return results;
}

const dump = (db: DatabaseSync) => ({
  calls: db.prepare(`SELECT * FROM tool_calls ORDER BY id`).all(),
  approvals: db.prepare(`SELECT * FROM approvals ORDER BY created_at, tool`).all(),
  audit: db.prepare(`SELECT seq, at, kind, ref, data_json FROM audit_chain ORDER BY seq`).all(),
});

describe("REST tool-call API vs MCP", () => {
  it("lists the same tools, with the same names and schemas", async () => {
    const w = await world();
    const client = await mcpClient(w.base, w.secret);
    const viaMcp = (await client.listTools()).tools;
    const viaRest = (await (await rest(w.base, w.secret, "GET", "/v1/tools")).json()) as { tools: Tool[] };
    assert.deepEqual(viaRest.tools, viaMcp);
    assert.deepEqual(viaRest.tools.map((t) => t.name), ["create_refund", "list_transactions", "handrail_get_approval"]);
    assert.ok("idempotency_key" in (viaRest.tools[0]!.inputSchema.properties ?? {}), "money tools get the optional idempotency_key");
    await client.close();
  });

  it("the same calls give the same results, decisions, records and audit entries", async () => {
    const viaMcpWorld = await world();
    const client = await mcpClient(viaMcpWorld.base, viaMcpWorld.secret);
    const mcpResults = await session(async (name, args) => (await client.callTool({ name, arguments: args })) as CallToolResult);
    await client.close();

    const viaRestWorld = await world();
    const restResults = await session(async (name, args) => {
      const res = await rest(viaRestWorld.base, viaRestWorld.secret, "POST", "/v1/tools/call", { name, arguments: args });
      assert.equal(res.status, 200);
      return (await res.json()) as CallToolResult;
    });

    assert.deepEqual(normalize(restResults), normalize(mcpResults), "identical results, including pending, duplicate, blocked and get_approval");
    const statuses = restResults.map((r) => {
      try {
        return JSON.parse((r.content.at(-1) as { text: string }).text).handrail?.status ?? "paypal";
      } catch {
        return "paypal";
      }
    });
    assert.deepEqual(statuses, ["paypal", "paypal", "pending_approval", "pending_approval", "pending_approval", "blocked", "pending_approval"]);

    const a = dump(viaMcpWorld.db);
    const b = dump(viaRestWorld.db);
    assert.deepEqual(normalize(b.calls), normalize(a.calls), "call log");
    assert.deepEqual(normalize(b.approvals), normalize(a.approvals), "approvals");
    assert.deepEqual(normalize(b.audit), normalize(a.audit), "audit chain entries");
    assert.ok(a.audit.length > 10);
    assert.deepEqual(viaRestWorld.sent, viaMcpWorld.sent, "PayPal received the same calls");
    assert.equal(viaRestWorld.sent.length, 2, "the read and the allowed refund; nothing held or blocked was sent");
  });

  it("a held call approved in the dashboard is returned by handrail_get_approval over REST", async () => {
    const w = await world();
    const held = (await (await rest(w.base, w.secret, "POST", "/v1/tools/call", { name: "create_refund", arguments: { capture_id: "CAP1", amount: { currency_code: "USD", value: "500.00" } } })).json()) as CallToolResult;
    const id = JSON.parse((held.content[0] as { text: string }).text).handrail.approval_id;
    await w.gate.approve(id, "Ada", null);
    const after = (await (await rest(w.base, w.secret, "POST", "/v1/tools/call", { name: "handrail_get_approval", arguments: { approval_id: id } })).json()) as CallToolResult;
    assert.match((after.content[0] as { text: string }).text, /approved by Ada/);
    assert.match((after.content[1] as { text: string }).text, /COMPLETED/);
  });
});

describe("REST tool-call API: access and input", () => {
  it("needs a valid agent key, like /mcp", async () => {
    const w = await world();
    for (const key of [null, "wrong", `hr_agent_${"x".repeat(40)}`]) {
      const res = await rest(w.base, key, "GET", "/v1/tools");
      assert.equal(res.status, 401, String(key));
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
    }
    const keyId = w.agentKeys.list()[0]!.id;
    w.agentKeys.revoke(keyId, { id: "u1", name: "Admin" }, NOW);
    assert.equal((await rest(w.base, w.secret, "POST", "/v1/tools/call", { name: "list_transactions" })).status, 401, "revoked");
    assert.equal(w.sent.length, 0);
  });

  it("rejects malformed requests without calling anything", async () => {
    const w = await world();
    const bad = async (body: unknown, expect: RegExp) => {
      const res = await rest(w.base, w.secret, "POST", "/v1/tools/call", body);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, expect);
    };
    await bad("{not json", /JSON/);
    await bad({ arguments: {} }, /name/);
    await bad({ name: "create_refund", arguments: [1] }, /arguments must be an object/);
    await bad({ name: "create_refund", arguments: "x" }, /arguments must be an object/);
    assert.equal((await rest(w.base, w.secret, "GET", "/v1/tools/call")).status, 405);
    assert.equal((await rest(w.base, w.secret, "POST", "/v1/tools")).status, 405);
    assert.equal(w.sent.length, 0);
  });
});
