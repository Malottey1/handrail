import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import * as React from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createAdminApi } from "../src/admin-api.js";
import { AI_TIMEOUT_MS, AnthropicLlm, type Llm } from "../src/ai/llm.js";
import type { Approval } from "../src/approvals.js";
import { AuditChain } from "../src/audit-chain.js";
import { AccountStore } from "../src/auth/accounts.js";
import type { HeldNotifier } from "../src/notify/notifier.js";
import type { PayPalRest } from "../src/paypal/rest.js";
import { parsePolicy } from "../src/policy/load.js";
import { SettingsStore } from "../src/notify/settings.js";
import { openWorkspace } from "../src/workspace.js";

const ADMIN_TOKEN = "degraded-test-admin-token";
const BAD_KEY = "degraded-test-rejected-key";
const POLICY = parsePolicy({
  version: 1,
  defaults: { read: "allow", write: "allow", money: "allow", unknown: "require_approval" },
  rules: [{ id: "refund-over-100", type: "amount_ceiling", tools: ["create_refund"], max: "100.00", currency: "USD", decision: "require_approval" }],
});
const refund = (value: string, key: string) => ({ capture_id: "CAPTURE1", amount: { currency_code: "USD", value }, idempotency_key: key });

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The real Anthropic SDK, talking to a fake Messages API. */
async function llmAgainst(handler: RequestListener, timeoutMs?: number): Promise<AnthropicLlm> {
  const base = await listen(handler);
  const before = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = base;
  try {
    return new AnthropicLlm(BAD_KEY, "fake-model", timeoutMs);
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = before;
  }
}

/** Answers the way Anthropic answers a bad key. */
const rejectedKeyLlm = () =>
  llmAgainst((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
  });

async function setup(llm: Llm | null) {
  const db = new DatabaseSync(":memory:");
  const audit = new AuditChain(db);
  const accounts = new AccountStore(db, audit);
  const settings = new SettingsStore(db, audit);
  const sent: string[] = [];
  const alerted: Approval[] = [];
  const workspace = openWorkspace({
    db,
    audit,
    upstream: { callTool: async () => ({ content: [] }) } as unknown as Client,
    rest: {} as PayPalRest,
    direct: {
      call: async (name: string) => {
        sent.push(name);
        return { content: [{ type: "text", text: JSON.stringify({ id: `REFUND${sent.length}`, status: "COMPLETED" }) }] };
      },
    },
    llm,
    policy: POLICY,
    policyPath: null,
    approvalWaitMs: 0,
    idempotencyWindowMs: 3_600_000,
    notifier: () => ({ held: async (a: Approval) => void alerted.push(a), unattributed: async () => {} }) as unknown as HeldNotifier,
    alertWaitMs: 0,
  });
  audit.start(Date.now());
  const api = createAdminApi({
    workspace,
    llm,
    accounts,
    settings,
    email: null,
    postSlack: async () => {},
    demo: null,
    adminToken: ADMIN_TOKEN,
    demoAccess: false,
    trustProxy: false,
    cookieSecure: "auto",
  } as unknown as Parameters<typeof createAdminApi>[0]);
  const base = await listen(async (req, res) => {
    if (!(await api(req, res))) res.writeHead(404).end();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, text: await r.clone().text(), data: await r.json() };
  };
  const hold = async (value: string, key: string): Promise<string> => {
    await workspace.gate.handle("create_refund", refund(value, key));
    const held = (await call("GET", "/approvals?status=pending")).data as Array<{ id: string; args: { amount: { value: string } } }>;
    return held.find((a) => a.args.amount.value === value)!.id;
  };
  /** Waits for a brief to settle (the real SDK answers over HTTP, after the gate has replied). */
  const settled = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const a = (await call("GET", `/approvals/${id}`)).data;
      if (a.explanationStatus !== "pending") return a;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the brief never settled");
  };
  return { call, hold, settled, sent, alerted, workspace };
}

const CASES: Array<{ name: string; llm: () => Promise<Llm | null>; brief: string; aiEnabled: boolean; draftError: RegExp }> = [
  { name: "missing", llm: async () => null, brief: "unavailable", aiEnabled: false, draftError: /^AI drafting is unavailable: ANTHROPIC_API_KEY isn't set/ },
  { name: "rejected", llm: rejectedKeyLlm, brief: "failed", aiEnabled: true, draftError: /^AI drafting is unavailable right now/ },
];

for (const c of CASES) {
  describe(`when the Anthropic key is ${c.name}`, () => {
    it("still holds a call, alerts, and lets a person approve or reject it", async () => {
      const w = await setup(await c.llm());
      const toApprove = await w.hold("250.00", "a");
      const toReject = await w.hold("300.00", "b");
      assert.deepEqual(w.sent, [], "nothing reaches PayPal while held");

      for (const id of [toApprove, toReject]) {
        const a = await w.settled(id);
        assert.equal(a.status, "pending", "losing the brief doesn't change the decision");
        assert.equal(a.explanationStatus, c.brief);
        assert.equal(a.explanation, null);
      }

      const approved = await w.call("POST", `/approvals/${toApprove}/approve`, { note: "ok" });
      assert.equal(approved.status, 200);
      assert.equal(approved.data.status, "executed");
      assert.deepEqual(w.sent, ["create_refund"], "approved: sent once");

      const rejected = await w.call("POST", `/approvals/${toReject}/reject`, { note: "no" });
      assert.equal(rejected.data.status, "rejected");
      assert.deepEqual(w.sent, ["create_refund"], "rejected: never sent");

      for (let i = 0; i < 200 && w.alerted.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(w.alerted.length, 2, "approvers are still alerted");
      assert.equal((await w.call("GET", "/audit/verify")).data.ok, true);
    });

    it("says AI drafting is unavailable, without leaking the cause, and leaves the policy alone", async () => {
      const w = await setup(await c.llm());
      const before = (await w.call("GET", "/policy")).data;
      assert.equal(before.ai.enabled, c.aiEnabled);

      const draft = await w.call("POST", "/policy/compile", { instruction: "Refunds over $250 need my approval" });
      assert.equal(draft.status, 503);
      assert.match(draft.data.error, c.draftError);
      assert.match(draft.data.error, /policy is unchanged and still enforced/);
      assert.ok(!/401|x-api-key|authentication_error|something went wrong/i.test(draft.text), draft.text);
      assert.ok(!draft.text.includes(BAD_KEY));

      assert.equal((await w.call("GET", "/policy")).data.hash, before.hash);
    });
  });
}

describe("when the model is too slow", () => {
  const CAP_MS = 300;
  /** Never finishes: `stall` accepts the request and says nothing; `trickle` starts a reply and stops. */
  const stall: RequestListener = () => {};
  const trickle: RequestListener = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"id":"msg_1",');
  };
  const counted = (handler: RequestListener) => {
    const counter = { requests: 0 };
    const counting: RequestListener = (req, res) => {
      counter.requests++;
      handler(req, res);
    };
    return { counter, counting };
  };

  it("caps a task at 20 seconds by default", () => {
    assert.equal(AI_TIMEOUT_MS, 20_000);
    assert.equal(new AnthropicLlm(BAD_KEY, "fake-model").timeoutMs, 20_000);
  });

  for (const [name, handler] of [["never answers", stall], ["stops mid-answer", trickle]] as const) {
    it(`gives up on a brief when the model ${name}, without affecting the held call`, async () => {
      const { counter, counting } = counted(handler);
      const w = await setup(await llmAgainst(counting, CAP_MS));

      const started = Date.now();
      const id = await w.hold("250.00", "a");
      assert.ok(Date.now() - started < CAP_MS, "the agent's answer doesn't wait for the brief");
      assert.equal((await w.call("GET", `/approvals/${id}`)).data.explanationStatus, "pending");

      const a = await w.settled(id);
      const elapsed = Date.now() - started;
      assert.equal(a.explanationStatus, "failed");
      assert.equal(a.status, "pending");
      assert.ok(elapsed >= CAP_MS - 20 && elapsed < CAP_MS + 700, `gave up after ${elapsed} ms`);
      assert.equal(counter.requests, 1, "not retried past the cap");
      assert.deepEqual(w.sent, [], "still held");

      const approved = await w.call("POST", `/approvals/${id}/approve`, {});
      assert.equal(approved.data.status, "executed");
      assert.deepEqual(w.sent, ["create_refund"]);
      assert.equal((await w.call("GET", "/audit/verify")).data.ok, true);
    });

    it(`says AI drafting is unavailable when the model ${name}`, async () => {
      const w = await setup(await llmAgainst(handler, CAP_MS));
      const before = (await w.call("GET", "/policy")).data.hash;
      const started = Date.now();
      const draft = await w.call("POST", "/policy/compile", { instruction: "Refunds over $250 need my approval" });
      const elapsed = Date.now() - started;
      assert.equal(draft.status, 503);
      assert.match(draft.data.error, /^AI drafting is unavailable right now/);
      assert.ok(elapsed < CAP_MS + 700, `gave up after ${elapsed} ms`);
      assert.equal((await w.call("GET", "/policy")).data.hash, before);
    });
  }

  it("lets a person decide while the brief is still being written, and the late failure changes nothing", async () => {
    const w = await setup(await llmAgainst(stall, CAP_MS));
    const toApprove = await w.hold("250.00", "a");
    const toReject = await w.hold("300.00", "b");
    assert.equal((await w.call("POST", `/approvals/${toApprove}/approve`, {})).data.status, "executed");
    assert.equal((await w.call("POST", `/approvals/${toReject}/reject`, {})).data.status, "rejected");
    assert.deepEqual(w.sent, ["create_refund"]);

    assert.equal((await w.settled(toApprove)).status, "executed");
    assert.equal((await w.settled(toReject)).status, "rejected");
    assert.deepEqual(w.sent, ["create_refund"]);
  });

  it("still allows by the rules while the model hangs", async () => {
    const w = await setup(await llmAgainst(stall, 60_000));
    const started = Date.now();
    await w.workspace.gate.handle("create_refund", refund("50.00", "small"));
    assert.deepEqual(w.sent, ["create_refund"], "under the limit: sent straight away");
    assert.ok(Date.now() - started < 1_000, "rules never wait for the model");
  });

  it("shares the cap between a draft and its repair round", async () => {
    const cap = 1_000;
    let requests = 0;
    const llm = await llmAgainst((_req, res) => {
      if (++requests > 1) return; // The repair request never answers.
      // A slow first answer that fails validation, using most of the cap.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "fake-model", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }));
      }, 800);
    }, cap);
    const w = await setup(llm);
    const started = Date.now();
    const draft = await w.call("POST", "/policy/compile", { instruction: "Refunds over $250 need my approval" });
    const elapsed = Date.now() - started;
    assert.equal(draft.status, 503);
    assert.equal(requests, 2, "the repair round was tried");
    // A cap per request would run to about 1,800 ms.
    assert.ok(elapsed < cap + 400, `gave up after ${elapsed} ms`);
  });
});

describe("the approval card without a brief", () => {
  // tsx compiles web/ with classic JSX, which needs React as a global.
  (globalThis as { React?: unknown }).React = React;
  // A variable path, so the server's typecheck doesn't pull in the browser code.
  const briefView = "../web/src/views/AiBrief.tsx";
  const render = async (explanationStatus: string | null) => {
    const { AiBrief } = (await import(briefView)) as { AiBrief: ComponentType<{ approval: unknown }> };
    return renderToStaticMarkup(createElement(AiBrief, { approval: { explanationStatus, explanation: null, explanationModel: null } }));
  };

  for (const status of ["unavailable", "failed"]) {
    it(`says the AI brief is unavailable when its status is ${status}`, async () => {
      const html = await render(status);
      assert.match(html, /AI brief unavailable/);
      assert.match(html, /You can still approve or reject it/);
      assert.ok(!/error|couldn|shimmer/i.test(html), html);
    });
  }

  it("shows nothing for a call that never had a brief, and a placeholder while it's being written", async () => {
    assert.equal(await render(null), "");
    const pending = await render("pending");
    assert.match(pending, /shimmer/);
    assert.ok(!pending.includes("unavailable"));
  });
});
