import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AnthropicLlm } from "../src/ai/llm.js";
import { ApprovalStore } from "../src/approvals.js";
import { AuditChain } from "../src/audit-chain.js";
import { CallLog } from "../src/audit.js";
import { newDemoRun, planDemo, runDemoAgent, type DemoPlan } from "../src/demo/agent.js";
import { withErrorBoundary } from "../src/error-boundary.js";
import { Gate } from "../src/gate.js";
import { OperationStore } from "../src/idempotency.js";
import { log } from "../src/log.js";
import { PayPalTokenManager } from "../src/paypal/auth.js";
import type { PayPalRest } from "../src/paypal/rest.js";
import { parsePolicy } from "../src/policy/load.js";
import { REDACTED, redact, redactDeep, registerClientCredentials, registerSecrets } from "../src/redact.js";

// Fakes are assembled at runtime so the secret scanner (scripts/check-secrets.mjs)
// never sees a credential-shaped literal in this file.
const FAKE_ANTHROPIC_KEY = ["sk", "ant", "api03", "x".repeat(40)].join("-");
const FAKE_PAYPAL_TOKEN = "A21" + "AA" + "y".repeat(50);
const FAKE_AGENT_KEY = "hr_" + "agent_" + "z".repeat(30);
// Configured secrets have no recognisable shape; they're caught by exact value.
const CONFIG_SECRET = "cfg" + "Q7".repeat(20);
const CLIENT_ID = "cid" + "R4".repeat(20);
const CLIENT_SECRET = "csec" + "W9".repeat(20);
const ALL = [FAKE_ANTHROPIC_KEY, FAKE_PAYPAL_TOKEN, FAKE_AGENT_KEY, CONFIG_SECRET, CLIENT_ID, CLIENT_SECRET];

registerSecrets(CONFIG_SECRET);
registerClientCredentials(CLIENT_ID, CLIENT_SECRET);

function assertClean(text: string, where: string) {
  for (const s of ALL) assert.ok(!text.includes(s), `${where} leaked a secret (${s.slice(0, 6)}…)`);
}

/** Runs fn with console.error captured; returns everything logged. */
async function captureLogs(fn: () => unknown): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("redact", () => {
  it("removes credential shapes", () => {
    const cases = [
      `Authorization: Bearer ${FAKE_PAYPAL_TOKEN}`,
      `authorization: basic ${Buffer.from("someone:" + "p".repeat(20)).toString("base64")}`,
      `key ${FAKE_ANTHROPIC_KEY} rejected`,
      `token ${FAKE_PAYPAL_TOKEN}`,
      `agent used ${FAKE_AGENT_KEY}`,
      `{"access_token":"${"t".repeat(30)}","expires_in":32000}`,
      `client_secret=${"s".repeat(30)}&grant_type=client_credentials`,
      `password: hunter2hunter2`,
    ];
    for (const c of cases) {
      const out = redact(c);
      assert.ok(out.includes(REDACTED), `not redacted: ${c.slice(0, 20)}…`);
      assertClean(out, "redact()");
    }
    assert.ok(!redact(`{"access_token":"${"t".repeat(30)}"}`).includes("t".repeat(30)));
  });

  it("removes the configured secrets by value, including the Basic encoding of the PayPal credentials", () => {
    assert.equal(redact(`failed with ${CONFIG_SECRET}.`), `failed with ${REDACTED}.`);
    assert.equal(redact(`id ${CLIENT_ID} secret ${CLIENT_SECRET}`), `id ${REDACTED} secret ${REDACTED}`);
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    assertClean(redact(`header was ${basic}`), "redact()");
    assert.ok(!redact(`header was ${basic}`).includes(basic));
  });

  it("leaves ordinary text alone, including PayPal ids and amounts", () => {
    const text = "Refund 5.00 USD on capture 2GG27306VR5212345 (PayPal-Request-Id 6b1c…); invoice INV2-ABCD-1234";
    assert.equal(redact(text), text);
    const value = { a: [{ b: "plain" }], n: 3 };
    assert.equal(redactDeep(value), value, "unchanged objects are returned as is");
  });

  it("redacts nested values", () => {
    const out = redactDeep({ args: { note: `use ${FAKE_AGENT_KEY}`, list: [CONFIG_SECRET, 1] }, ok: true });
    assertClean(JSON.stringify(out), "redactDeep()");
    assert.equal(out.ok, true);
  });
});

describe("redaction on every path out", () => {
  it("logs", async () => {
    const out = await captureLogs(() => {
      log(`PayPal said: Bearer ${FAKE_PAYPAL_TOKEN}`);
      log("Fatal:", new Error(`bad key ${CONFIG_SECRET}`));
      log(`client ${CLIENT_ID}:${CLIENT_SECRET}`);
    });
    assert.ok(out.includes(REDACTED));
    assertClean(out, "log()");
  });

  it("the PayPal access token is redacted once Handrail has it", async () => {
    const original = globalThis.fetch;
    const token = "tok" + "M3".repeat(25);
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 32400 }))) as typeof fetch;
    try {
      const tokens = new PayPalTokenManager("https://api-m.sandbox.paypal.com", CLIENT_ID, CLIENT_SECRET);
      const logs = await captureLogs(() => tokens.getToken());
      assert.ok(!logs.includes(token));
      assert.ok(!redact(`upstream echoed ${token}`).includes(token));
    } finally {
      globalThis.fetch = original;
    }
  });

  it("agent arguments and PayPal results: what's stored, audited, shown to approvers, returned to the agent or sent on", async () => {
    const policy = parsePolicy({
      version: 1,
      defaults: { read: "allow", write: "allow", money: "allow", unknown: "require_approval" },
      rules: [{ id: "approve-over-100", type: "amount_ceiling", tools: ["create_refund"], max: "100.00", currency: "USD", decision: "require_approval" }],
    });
    const sent: unknown[] = [];
    const answer = async (args: unknown): Promise<CallToolResult> => {
      sent.push(args);
      // A PayPal (or upstream) answer that echoes credentials back.
      return { content: [{ type: "text", text: JSON.stringify({ id: "REFUND1", status: "COMPLETED", debug: `Bearer ${FAKE_PAYPAL_TOKEN} ${CONFIG_SECRET}` }) }] };
    };
    const db = new DatabaseSync(":memory:");
    const audit = new AuditChain(db);
    audit.start(Date.now());
    const callLog = new CallLog(db, audit);
    const approvals = new ApprovalStore(db, audit);
    const gate = new Gate(
      {
        upstream: { callTool: (p: { arguments?: unknown }) => answer(p.arguments) } as unknown as Client,
        rest: { get: async () => ({ amount: { currency_code: "USD", value: "500.00" } }) } as unknown as PayPalRest,
        direct: { call: (_tool: string, args: Record<string, unknown>) => answer(args) },
        callLog,
        approvals,
        operations: new OperationStore(db, 3_600_000),
        policy: () => policy,
      },
      { approvalWaitMs: 0, approvalTtlMs: 3_600_000 },
    );
    const note = `Customer said: Authorization: Bearer ${FAKE_PAYPAL_TOKEN}, key ${FAKE_ANTHROPIC_KEY}, ${FAKE_AGENT_KEY}`;

    const logs = await captureLogs(async () => {
      const allowed = await gate.handle("create_refund", { capture_id: "CAP1", amount: { currency_code: "USD", value: "5.00" }, note_to_payer: note });
      assertClean(JSON.stringify(allowed), "the result returned to the agent");
      const held = await gate.handle("create_refund", { capture_id: "CAP2", amount: { currency_code: "USD", value: "250.00" }, note_to_payer: note });
      assertClean(JSON.stringify(held), "the held result returned to the agent");
    });
    assertClean(logs, "logs");
    assertClean(JSON.stringify(sent), "what was sent to PayPal");
    assert.equal(sent.length, 1);

    const pending = approvals.list("pending");
    assert.equal(pending.length, 1);
    assertClean(JSON.stringify(pending), "the approval card");
    const decided = await gate.approve(pending[0]!.id, "Approver", null);
    assertClean(JSON.stringify(decided), "the approval result");

    for (const table of ["tool_calls", "approvals", "operations", "audit_chain"]) {
      assertClean(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), `the ${table} table`);
    }
    assert.equal(audit.verify().ok, true);
  });

  it("prompts sent to the AI", async () => {
    let body = "";
    const base = await listen(
      createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          body = data;
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "test",
              content: [{ type: "text", text: "{}" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
        });
      }),
    );
    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = base;
    try {
      const llm = new AnthropicLlm("test-key", "test");
      await llm.json({
        system: `Policy notes mention ${CONFIG_SECRET}`,
        user: `Agent arguments: {"note":"Bearer ${FAKE_PAYPAL_TOKEN}"} and ${FAKE_AGENT_KEY}`,
        schema: { type: "object", properties: {} },
        name: "t",
        description: "t",
      });
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous;
    }
    assert.ok(body.includes("Agent arguments"), "the prompt was sent");
    assertClean(body, "the AI request");
  });

  it("demo agent errors shown in the dashboard", async () => {
    const policy = parsePolicy({
      version: 1,
      defaults: { read: "allow", write: "allow", money: "allow", unknown: "require_approval" },
      rules: [{ id: "approve-over-100", type: "amount_ceiling", tools: ["create_refund"], max: "100.00", currency: "USD", decision: "require_approval" }],
    });
    const run = newDemoRun(planDemo(policy) as DemoPlan, Date.now());
    await runDemoAgent(run, {
      connect: async () => assert.fail("not reached"),
      createSale: async () => {
        throw new Error(`PayPal rejected Bearer ${FAKE_PAYPAL_TOKEN} (client ${CLIENT_ID})`);
      },
      onSale: () => {},
      callLog: { recent: () => [] },
      agentKeyId: "k",
    });
    assert.equal(run.status, "failed");
    assertClean(JSON.stringify(run), "the demo run");
  });

  it("unexpected server errors: a generic 500 with an id, no message or stack trace, and the server keeps running", async () => {
    let calls = 0;
    const base = await listen(
      createServer(
        withErrorBoundary(async (_req, res) => {
          if (++calls === 1) throw new Error(`SQLITE_ERROR near ${CONFIG_SECRET} in /srv/handrail/src/secret-path.ts`);
          res.writeHead(200).end("ok");
        }),
      ),
    );
    const logs = await captureLogs(async () => {
      const res = await fetch(`${base}/anything`);
      assert.equal(res.status, 500);
      const text = await res.text();
      const body = JSON.parse(text) as { error: string; errorId: string };
      assert.match(body.errorId, /^[0-9a-f]{12}$/);
      assert.ok(!text.includes("SQLITE") && !text.includes("secret-path") && !text.includes("    at "), "no internal detail or stack");
      assertClean(text, "the 500 response");
    });
    assert.ok(logs.includes("SQLITE_ERROR"), "the detail is in the server log");
    assertClean(logs, "the server log");
    assert.equal(await (await fetch(`${base}/again`)).text(), "ok");
  });
});
