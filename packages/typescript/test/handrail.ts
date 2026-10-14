// A real Handrail (tool-call API, gate, policy, call log, audit chain) in front
// of a fake PayPal that serves PayPal's recorded tool list. The wrappers talk
// to it exactly as they would to a deployed Handrail.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { after } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalStore } from "../../../src/approvals.js";
import { AuditChain } from "../../../src/audit-chain.js";
import { CallLog } from "../../../src/audit.js";
import { AgentKeyStore } from "../../../src/auth/agent-keys.js";
import { Gate } from "../../../src/gate.js";
import { OperationStore } from "../../../src/idempotency.js";
import type { PayPalRest } from "../../../src/paypal/rest.js";
import { parsePolicy } from "../../../src/policy/load.js";
import { handleToolApi } from "../../../src/tool-api.js";
import { resultJson } from "../core/client.js";

export const FIXTURE = JSON.parse(readFileSync(new URL("../../../test/fixtures/paypal-mcp-server.json", import.meta.url), "utf8"));

const POLICY = parsePolicy({
  version: 1,
  defaults: { read: "allow", write: "allow", money: "allow", unknown: "require_approval" },
  rules: [{ id: "refund-approval-over-100", type: "amount_ceiling", tools: ["create_refund"], max: "100.00", currency: "USD", decision: "require_approval" }],
});

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

export const fakeUpstream = {
  listTools: async () => ({ tools: FIXTURE.tools }),
  getServerCapabilities: () => ({ tools: {} }),
  getInstructions: () => undefined,
} as unknown as Client;

export async function startHandrail() {
  const db = new DatabaseSync(":memory:");
  const audit = new AuditChain(db);
  const callLog = new CallLog(db, audit);
  const approvals = new ApprovalStore(db, audit);
  const agentKeys = new AgentKeyStore(db, audit);
  audit.start(Date.now());
  const { secret } = agentKeys.create("Support bot", { id: "u1", name: "Admin" }, Date.now());
  const paypal: Array<{ name: string; args: Record<string, unknown> }> = [];
  const answer = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    paypal.push({ name, args });
    return { content: [{ type: "text", text: JSON.stringify({ id: `REFUND${paypal.length}`, status: "COMPLETED" }) }] };
  };
  const upstream = { ...fakeUpstream, callTool: (p: { name: string; arguments?: Record<string, unknown> }) => answer(p.name, p.arguments ?? {}) } as unknown as Client;
  const gate = new Gate(
    {
      upstream,
      rest: { get: async () => ({ id: "CAP1", amount: { currency_code: "USD", value: "500.00" } }) } as unknown as PayPalRest,
      direct: { call: (name: string, args: Record<string, unknown>) => answer(name, args) },
      callLog,
      approvals,
      operations: new OperationStore(db, 3_600_000),
      policy: () => POLICY,
    },
    { approvalWaitMs: 0 },
  );
  const server = createServer(async (req, res) => {
    if (!(await handleToolApi(req, res, { upstream, gate, agentKeys, agentToken: undefined }))) res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, agentKey: secret, paypal, callLog, approvals, server };
}

export const REFUNDS = { actions: { payments: { createRefund: true } }, context: { sandbox: true } };
export const refund = (value: string) => ({ capture_id: "2GG27306VR5212345", amount: { currency_code: "USD", value } });
export const status = (text: string) => {
  const body = resultJson(text);
  return body ? (body.handrail?.status ?? body.status) : text;
};
