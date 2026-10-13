import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createAdminApi, demoPassword } from "../src/admin-api.js";
import { ApprovalStore } from "../src/approvals.js";
import { AuditChain } from "../src/audit-chain.js";
import { CallLog } from "../src/audit.js";
import { AccountStore } from "../src/auth/accounts.js";
import { AgentKeyStore } from "../src/auth/agent-keys.js";
import { checkAdminToken } from "../src/auth/http.js";
import { hashPassword } from "../src/auth/passwords.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DemoService } from "../src/demo/workspaces.js";
import { handleWebhook } from "../src/webhook-endpoint.js";
import { openWorkspace } from "../src/workspace.js";
import { Gate } from "../src/gate.js";
import { OperationStore } from "../src/idempotency.js";
import { handleMcp } from "../src/mcp-endpoint.js";
import type { PayPalRest } from "../src/paypal/rest.js";
import { parsePolicy } from "../src/policy/load.js";
import { PolicyStore } from "../src/policy/store.js";
import type { CallFacts, Evaluation } from "../src/policy/types.js";
import { WebhookStore } from "../src/webhooks.js";
import { registerSecrets } from "../src/redact.js";

const POLICY = parsePolicy({
  version: 1,
  defaults: { read: "allow", write: "allow", money: "allow", unknown: "require_approval" },
  rules: [{ id: "approve-over-100", type: "amount_ceiling", tools: ["create_refund"], max: "100.00", currency: "USD", decision: "require_approval" }],
});
const ADMIN_TOKEN = "a".repeat(40);
const PASSWORD = "correct horse battery";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function setup(opts: { demoAccess?: boolean; cookieSecure?: boolean | "auto"; adminToken?: string | undefined } = {}) {
  const db = new DatabaseSync(":memory:");
  const audit = new AuditChain(db);
  const callLog = new CallLog(db, audit);
  const approvals = new ApprovalStore(db, audit);
  const accounts = new AccountStore(db, audit);
  const agentKeys = new AgentKeyStore(db, audit);
  const webhooks = new WebhookStore(db, audit);
  audit.start(Date.now());
  const policyPath = join(mkdtempSync(join(tmpdir(), "handrail-auth-")), "policy.json");
  writeFileSync(policyPath, JSON.stringify(POLICY));
  const policy = new PolicyStore(policyPath, audit, POLICY);

  const sent: string[] = [];
  const answer = async (name: string): Promise<CallToolResult> => {
    sent.push(name);
    return { content: [{ type: "text", text: `paypal:${name}` }] };
  };
  const upstream = {
    callTool: (p: { name: string }) => answer(p.name),
    listTools: async () => ({ tools: [] }),
    getServerCapabilities: () => ({ tools: {} }),
    getInstructions: () => undefined,
  } as unknown as Client;
  const gate = new Gate(
    {
      upstream,
      rest: {} as PayPalRest,
      direct: { call: (name: string) => answer(name) },
      callLog,
      approvals,
      operations: new OperationStore(db, 3_600_000),
      policy: () => policy.get(),
    },
    { approvalWaitMs: 0, approvalTtlMs: 3_600_000 },
  );
  if (opts.demoAccess) accounts.ensureDemoUser(await hashPassword(demoPassword()), Date.now());

  // Demo workspaces: like the real one, but each in its own in-memory database.
  // Refunds "succeed" at a fake PayPal; sales are fake captures.
  const demoSent: string[] = [];
  let sales = 0;
  let base = "";
  const demo = opts.demoAccess
    ? new DemoService({
        realDb: db,
        open: () => {
          const demoDb = new DatabaseSync(":memory:");
          return openWorkspace({
            db: demoDb,
            audit: new AuditChain(demoDb),
            upstream,
            rest: {} as PayPalRest,
            direct: {
              call: async (name: string) => {
                demoSent.push(name);
                return { content: [{ type: "text", text: JSON.stringify({ id: `REFUND${demoSent.length}`, status: "COMPLETED" }) }] };
              },
            },
            llm: null,
            policy: policy.get(),
            policyPath: null,
            approvalWaitMs: 0,
            approvalTtlMs: 3_600_000,
            idempotencyWindowMs: 3_600_000,
          });
        },
        // The demo agent reaches the gate the way any agent does: MCP over HTTP with its key.
        connect: async (key) => {
          const client = new McpClient({ name: "demo-agent-test", version: "0" });
          await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
          return client;
        },
        createSale: async () => ({ orderId: `ORDER${++sales}`, captureId: `DEMOCAPTURE${sales}` }),
      })
    : null;
  if (demo) after(() => demo.close());

  const api = createAdminApi({
    workspace: { gate, callLog, webhooks, audit, policy, agentKeys },
    llm: null,
    accounts,
    demo,
    adminToken: "adminToken" in opts ? opts.adminToken : ADMIN_TOKEN,
    demoAccess: !!opts.demoAccess,
    trustProxy: false,
    cookieSecure: opts.cookieSecure ?? "auto",
  });
  const server = createServer(async (req, res) => {
    if (req.url === "/mcp") return handleMcp(req, res, { upstream, gate, agentKeys, agentToken: undefined, demo });
    if (req.url === "/webhooks/paypal") {
      return handleWebhook(req, res, { rest: {} as PayPalRest, callLog, store: webhooks, webhookId: "WH-TEST", allowUnverified: true, demo });
    }
    if (!(await api(req, res))) res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Holds a refund for approval, as if an agent had asked for it. */
  const heldRefund = () => {
    const facts: CallFacts = {
      tool: "create_refund",
      args: { capture_id: "CAPTURE0000000001", amount: { currency_code: "USD", value: "250.00" } },
      amount: { hundredths: 25000, currency: "USD" },
      amountSource: "arguments",
      payee: null,
    };
    const evaluation: Evaluation = { decision: "require_approval", toolClass: "money", hits: [], reason: "over 100" };
    return approvals.create(facts, evaluation, Date.now(), 3_600_000);
  };

  return { base, db, audit, accounts, agentKeys, callLog, approvals, webhooks, policy, sent, demo, demoSent, heldRefund, browser: () => new Browser(base) };
}

/** A browser: keeps the session cookie, sends Origin, and echoes the CSRF token. */
class Browser {
  cookie: string | null = null;
  csrf: string | null = null;
  lastSetCookie: string | null = null;
  constructor(readonly base: string) {}

  async req(method: string, path: string, body?: unknown, opts: { csrf?: boolean; origin?: string } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: opts.origin ?? this.base };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrf && opts.csrf !== false) headers["X-CSRF-Token"] = this.csrf;
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      this.lastSetCookie = setCookie;
      const value = setCookie.split(";")[0]!;
      this.cookie = value.endsWith("=") ? null : value;
    }
    const data = (await res.json().catch(() => null)) as any;
    if (data?.csrfToken) this.csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  }

  signup(name: string, email: string, invite?: string) {
    return this.req("POST", "/api/auth/signup", { name, email, password: PASSWORD, invite });
  }

  login(email: string, password = PASSWORD) {
    return this.req("POST", "/api/auth/login", { email, password });
  }
}

/** An admin, plus an approver and a viewer who joined by invite. */
async function team() {
  const ctx = await setup();
  const admin = ctx.browser();
  assert.equal((await admin.signup("Malcolm Clottey", "malcolm@example.com")).status, 200);
  const join = async (name: string, email: string, role: string) => {
    const invite = await admin.req("POST", "/api/invites", { email, role });
    assert.equal(invite.status, 201);
    const b = ctx.browser();
    assert.equal((await b.signup(name, email, new URL(invite.data.link, ctx.base).searchParams.get("invite")!)).status, 200);
    return b;
  };
  return { ...ctx, admin, approver: await join("Ada Approver", "ada@example.com", "approver"), viewer: await join("Vic Viewer", "vic@example.com", "viewer") };
}

describe("auth: accounts and sessions", () => {
  it("makes the first sign-up the admin, and requires an invite after that", async () => {
    const { browser, base } = await setup();
    const first = await browser().signup("Malcolm Clottey", "Malcolm@Example.com");
    assert.equal(first.status, 200);
    assert.equal(first.data.user.role, "admin");
    assert.equal(first.data.user.email, "malcolm@example.com");

    const second = await browser().signup("Someone Else", "else@example.com");
    assert.equal(second.status, 403);
    assert.match(second.data.error, /invite/);

    const session = await (await fetch(`${base}/api/auth/session`)).json();
    assert.equal(session.setupRequired, false);
  });

  it("gives invited users the invited role, once, and only for the invited email", async () => {
    const { browser, base } = await setup();
    const admin = browser();
    await admin.signup("Malcolm Clottey", "malcolm@example.com");
    const invite = await admin.req("POST", "/api/invites", { email: "ada@example.com", role: "approver" });
    const token = new URL(invite.data.link, base).searchParams.get("invite")!;

    assert.equal((await browser().signup("Mallory", "mallory@example.com", token)).status, 403);
    const ada = await browser().signup("Ada Approver", "ada@example.com", token);
    assert.equal(ada.status, 200);
    assert.equal(ada.data.user.role, "approver");
    assert.equal((await browser().signup("Ada Again", "ada2@example.com", token)).status, 403);
  });

  it("stores passwords as argon2id hashes, never in plain text", async () => {
    const { browser, db } = await setup();
    await browser().signup("Malcolm Clottey", "malcolm@example.com");
    const row = db.prepare(`SELECT password_hash FROM users`).get() as { password_hash: string };
    assert.match(row.password_hash, /^\$argon2id\$/);
    assert.ok(!row.password_hash.includes(PASSWORD));
    const audit = JSON.stringify(db.prepare(`SELECT data_json FROM audit_chain`).all());
    assert.ok(!audit.includes("argon2") && !audit.includes(PASSWORD), "no password material in the audit log");
  });

  it("sets an httpOnly, SameSite=Strict session cookie, Secure outside localhost", async () => {
    const local = (await setup()).browser();
    await local.signup("Malcolm Clottey", "malcolm@example.com");
    assert.match(local.lastSetCookie!, /HttpOnly/);
    assert.match(local.lastSetCookie!, /SameSite=Strict/);
    assert.doesNotMatch(local.lastSetCookie!, /Secure/); // plain HTTP on 127.0.0.1 (development)

    const secure = (await setup({ cookieSecure: true })).browser();
    await secure.signup("Malcolm Clottey", "malcolm@example.com");
    assert.match(secure.lastSetCookie!, /; Secure/);
  });

  it("rate-limits failed logins, even when the right password follows", async () => {
    const { browser } = await setup();
    await browser().signup("Malcolm Clottey", "malcolm@example.com");
    const attacker = browser();
    for (let i = 0; i < 5; i++) assert.equal((await attacker.login("malcolm@example.com", "wrong password!")).status, 401);
    const blocked = await attacker.login("malcolm@example.com");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  });

  it("gives the same answer for an unknown email and a wrong password", async () => {
    const { browser } = await setup();
    await browser().signup("Malcolm Clottey", "malcolm@example.com");
    const unknown = await browser().login("nobody@example.com");
    const wrong = await browser().login("malcolm@example.com", "wrong password!");
    assert.deepEqual([unknown.status, unknown.data], [wrong.status, wrong.data]);
  });

  it("logs out by deleting the session", async () => {
    const { browser } = await setup();
    const me = browser();
    await me.signup("Malcolm Clottey", "malcolm@example.com");
    const cookie = me.cookie;
    assert.equal((await me.req("POST", "/api/auth/logout")).status, 200);
    me.cookie = cookie; // replaying the old cookie doesn't work
    assert.equal((await me.req("GET", "/api/summary")).status, 401);
  });

  it("edits the profile and changes the password", async () => {
    const { browser } = await setup();
    const me = browser();
    await me.signup("Malcolm Clottey", "malcolm@example.com");
    const edited = await me.req("PATCH", "/api/me", { name: "Malcolm C.", email: "mc@example.com" });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.user.name, "Malcolm C.");

    assert.equal((await me.req("POST", "/api/me/password", { currentPassword: "nope nope nope", newPassword: "a brand new passphrase" })).status, 403);
    assert.equal((await me.req("POST", "/api/me/password", { currentPassword: PASSWORD, newPassword: "short" })).status, 400);
    assert.equal((await me.req("POST", "/api/me/password", { currentPassword: PASSWORD, newPassword: "a brand new passphrase" })).status, 200);
    assert.equal((await browser().login("mc@example.com")).status, 401);
    assert.equal((await browser().login("mc@example.com", "a brand new passphrase")).status, 200);
  });
});

describe("auth: every endpoint is enforced server-side", () => {
  it("rejects unauthenticated requests", async () => {
    const { base, heldRefund } = await setup();
    const id = heldRefund().id;
    for (const [method, path] of [
      ["GET", "/api/summary"],
      ["GET", "/api/approvals"],
      ["GET", "/api/calls"],
      ["GET", "/api/audit"],
      ["GET", "/api/policy"],
      ["POST", `/api/approvals/${id}/approve`],
      ["PUT", "/api/policy"],
      ["GET", "/api/users"],
      ["POST", "/api/agent-keys"],
    ]) {
      const res = await fetch(base + path!, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    const wrongToken = await fetch(`${base}/api/summary`, { headers: { Authorization: "Bearer not-the-token" } });
    assert.equal(wrongToken.status, 401);
  });

  it("requires the CSRF token on changes made with a session cookie", async () => {
    const { admin } = await team();
    const missing = await admin.req("POST", "/api/agent-keys", { name: "bot" }, { csrf: false });
    assert.equal(missing.status, 403);
    assert.match(missing.data.error, /CSRF/);
    assert.equal((await admin.req("POST", "/api/agent-keys", { name: "bot" })).status, 201);
  });

  it("refuses cross-site requests, including sign-in", async () => {
    const { browser } = await team();
    const evil = await browser().req("POST", "/api/auth/login", { email: "malcolm@example.com", password: PASSWORD }, { origin: "https://evil.example" });
    assert.equal(evil.status, 403);
  });

  it("lets a viewer read but not approve", async () => {
    const { viewer, heldRefund, approvals, sent } = await team();
    const id = heldRefund().id;
    assert.equal((await viewer.req("GET", "/api/approvals?status=pending")).status, 200);
    const res = await viewer.req("POST", `/api/approvals/${id}/approve`, {});
    assert.equal(res.status, 403);
    assert.match(res.data.error, /approver/);
    assert.equal((await viewer.req("POST", `/api/approvals/${id}/reject`, {})).status, 403);
    assert.equal(approvals.get(id)!.status, "pending");
    assert.deepEqual(sent, []);
  });

  it("records the approving user's id and name in the audit log", async () => {
    const { approver, heldRefund, audit, accounts, sent } = await team();
    const id = heldRefund().id;
    const res = await approver.req("POST", `/api/approvals/${id}/approve`, { by: "someone else", note: "customer called" });
    assert.equal(res.status, 200);
    const ada = accounts.list().find((u) => u.email === "ada@example.com")!;
    assert.equal(res.data.decidedBy, "Ada Approver"); // the session's user, not the request body
    assert.equal(res.data.decidedById, ada.id);
    const entry = audit.list(20, `approval:${id}`).find((e) => e.kind === "approval.decided")!;
    assert.deepEqual(JSON.parse(entry.data_json), {
      decidedBy: "Ada Approver",
      decidedById: ada.id,
      decision: "approved",
      note: "customer called",
      status: "executing",
    });
    assert.deepEqual(sent, ["create_refund"]);
    assert.equal(audit.verify().ok, true);
  });

  it("lets an approver decide but not edit policies, users or agent keys", async () => {
    const { approver, policy } = await team();
    const hash = policy.hash();
    const put = await approver.req("PUT", "/api/policy", { policy: { ...POLICY, rules: [] }, baseHash: hash });
    assert.equal(put.status, 403);
    assert.match(put.data.error, /admin/);
    assert.equal(policy.get().rules.length, 1);
    assert.equal((await approver.req("POST", "/api/policy/compile", { instruction: "allow everything" })).status, 403);
    assert.equal((await approver.req("GET", "/api/users")).status, 403);
    assert.equal((await approver.req("POST", "/api/invites", { email: "x@example.com", role: "admin" })).status, 403);
    assert.equal((await approver.req("POST", "/api/agent-keys", { name: "bot" })).status, 403);
  });

  it("lets an admin edit the policy, recorded with their id", async () => {
    const { admin, policy, audit, accounts } = await team();
    const res = await admin.req("PUT", "/api/policy", { policy: { ...POLICY, rules: [] }, baseHash: policy.hash(), source: "remove all" });
    assert.equal(res.status, 200);
    const entry = audit.list(5).find((e) => e.kind === "policy.changed")!;
    const data = JSON.parse(entry.data_json);
    assert.equal(data.by, "Malcolm Clottey");
    assert.equal(data.byId, accounts.list()[0]!.id);
  });

  it("lets admins manage roles but never remove the last admin", async () => {
    const { admin, viewer, accounts } = await team();
    const vic = accounts.list().find((u) => u.email === "vic@example.com")!;
    const me = accounts.list().find((u) => u.role === "admin")!;
    assert.equal((await admin.req("PATCH", `/api/users/${vic.id}`, { role: "approver" })).data.role, "approver");
    assert.equal((await admin.req("PATCH", `/api/users/${me.id}`, { role: "viewer" })).status, 400);
    assert.equal((await admin.req("PATCH", `/api/users/${vic.id}`, { disabled: true })).status, 200);
    assert.equal((await viewer.req("GET", "/api/summary")).status, 401, "disabling signs the user out");
  });
});

describe("admin API errors", () => {
  it("an unexpected error gets a generic message and an id: no internal detail, stack trace or secret", async () => {
    const secret = "cfg" + "Z5".repeat(20);
    registerSecrets(secret);
    const { base, callLog } = await setup();
    callLog.recent = () => {
      throw new Error(`SQLITE_CORRUPT in /srv/handrail/src/audit.ts with ${secret}`);
    };
    const browser = new Browser(base);
    await browser.signup("Ada", "ada@example.com");
    const res = await browser.req("GET", "/api/calls");
    assert.equal(res.status, 500);
    const text = JSON.stringify(res.data);
    assert.match(String(res.data?.errorId), /^[0-9a-f]{12}$/);
    for (const leak of ["SQLITE", "/srv/", secret, "    at "]) assert.ok(!text.includes(leak), `leaked ${leak.slice(0, 8)}`);
  });

  it("expected errors still say what went wrong, redacted", async () => {
    const { base } = await setup();
    const browser = new Browser(base);
    await browser.signup("Ada", "ada@example.com");
    // An invalid policy names the unknown tool in its error; here the "tool" is a pasted key.
    const current = await browser.req("GET", "/api/policy");
    const key = "hr_" + "agent_" + "k".repeat(30);
    const policy = { ...current.data.policy, rules: [{ id: "r1", type: "tool", tools: [key], decision: "require_approval" }] };
    const res = await browser.req("PUT", "/api/policy", { policy, baseHash: current.data.hash });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /unknown tool/);
    assert.ok(typeof res.data?.error === "string" && res.data.error.length > 0, "the reason is still given");
    assert.ok(!JSON.stringify(res.data).includes("k".repeat(30)));
  });
});

describe("auth: the admin token", () => {
  const withToken = (base: string, token: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("is refused entirely when HANDRAIL_ADMIN_TOKEN is unset", async () => {
    const { base, heldRefund, approvals, sent } = await setup({ adminToken: undefined });
    const id = heldRefund().id;
    for (const guess of ["", "undefined", "null", ADMIN_TOKEN]) {
      assert.equal((await withToken(base, guess, "GET", "/api/summary")).status, 401, `bearer "${guess}"`);
      assert.equal((await withToken(base, guess, "POST", `/api/approvals/${id}/approve`, {})).status, 401);
    }
    assert.equal(approvals.get(id)!.status, "pending");
    assert.deepEqual(sent, []);
  });

  it("records everything done with it as \"Admin script\", never anonymously", async () => {
    const { base, heldRefund, audit, policy } = await setup();
    const rejected = heldRefund().id;
    const res = await withToken(base, ADMIN_TOKEN, "POST", `/api/approvals/${rejected}/reject`, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.decidedBy, "Admin script");
    assert.equal(body.decidedById, "admin-script");
    const decided = audit.list(20, `approval:${rejected}`).find((e) => e.kind === "approval.decided")!;
    assert.equal(JSON.parse(decided.data_json).decidedBy, "Admin script");
    assert.equal(JSON.parse(decided.data_json).decidedById, "admin-script");

    // A script may label itself; the label is kept next to the name, not instead of it.
    const labelled = heldRefund().id;
    const res2 = await withToken(base, ADMIN_TOKEN, "POST", `/api/approvals/${labelled}/reject`, { by: "nightly cleanup" });
    assert.equal((await res2.json()).decidedBy, "Admin script (nightly cleanup)");

    assert.equal((await withToken(base, ADMIN_TOKEN, "PUT", "/api/policy", { policy: POLICY, baseHash: policy.hash() })).status, 200);
    const changed = JSON.parse(audit.list(5).find((e) => e.kind === "policy.changed")!.data_json);
    assert.equal(changed.by, "Admin script");
    assert.equal(changed.byId, "admin-script");

    const key = await withToken(base, ADMIN_TOKEN, "POST", "/api/agent-keys", { name: "Script bot" });
    assert.equal(key.status, 201);
    const created = JSON.parse(audit.list(5).find((e) => e.kind === "agent_key.created")!.data_json);
    assert.deepEqual(created.by, { id: "admin-script", name: "Admin script" });
    assert.equal(audit.verify().ok, true);
  });

  it("stops Handrail from starting on Render", () => {
    assert.throws(() => checkAdminToken(ADMIN_TOKEN, { RENDER: "true" }), /must not be set on Render/);
    assert.throws(() => checkAdminToken(ADMIN_TOKEN, { RENDER_SERVICE_ID: "srv-123" }), /must not be set on Render/);
    assert.equal(checkAdminToken(undefined, { RENDER: "true" }), undefined);
    assert.equal(checkAdminToken(ADMIN_TOKEN, {}), ADMIN_TOKEN);
  });
});

describe("auth: demo access", () => {
  it("is off unless enabled", async () => {
    const { browser } = await setup();
    assert.equal((await browser().req("POST", "/api/auth/demo")).status, 404);
  });

  it("signs in as an approver that can't change its credentials or reach admin routes", async () => {
    const { browser, base, heldRefund } = await setup({ demoAccess: true });
    const session = await (await fetch(`${base}/api/auth/session`)).json();
    assert.equal(session.demoAccess, true);
    assert.equal(session.setupRequired, true, "the demo account doesn't count as the first admin");

    const judge = browser();
    const res = await judge.req("POST", "/api/auth/demo");
    assert.equal(res.status, 200);
    assert.equal(res.data.user.role, "approver");
    assert.equal((await judge.req("POST", `/api/approvals/${heldRefund().id}/approve`, {})).status, 404, "real approvals aren't visible to the demo");
    assert.equal((await judge.req("POST", "/api/me/password", { currentPassword: "x", newPassword: "something long enough" })).status, 403);
    assert.equal((await judge.req("PATCH", "/api/me", { name: "Hacker", email: "h@example.com" })).status, 403);
    assert.equal((await judge.req("GET", "/api/users")).status, 403);
    assert.equal((await browser().login("demo@handrail.example", "anything at all")).status, 401, "no password sign-in for the demo account");
  });
});

describe("demo agent and demo isolation", () => {
  async function signInDemo(ctx: Awaited<ReturnType<typeof setup>>) {
    const judge = ctx.browser();
    assert.equal((await judge.req("POST", "/api/auth/demo")).status, 200);
    return judge;
  }

  async function runToEnd(judge: Browser) {
    const started = await judge.req("POST", "/api/demo/run");
    assert.equal(started.status, 202, JSON.stringify(started.data));
    for (let i = 0; i < 100; i++) {
      const { data } = await judge.req("GET", "/api/demo/run");
      if (data.run.status !== "running") return data;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("demo run didn't finish");
  }

  it("runs a scripted agent through the gateway: allowed, held for approval, retry deduplicated", async () => {
    const ctx = await setup({ demoAccess: true });
    const judge = await signInDemo(ctx);
    const status = await runToEnd(judge);

    assert.equal(status.run.status, "done", JSON.stringify(status.run));
    assert.deepEqual(
      status.run.steps.map((s: { id: string; status: string }) => [s.id, s.status]),
      [["sale", "done"], ["small", "done"], ["large", "done"], ["retry", "done"]],
    );
    assert.deepEqual(status.run.plan, { limit: "100.00", ruleId: "approve-over-100", small: "5.00", large: "120.00", sale: "125.00" });
    assert.deepEqual(ctx.demoSent, ["create_refund"], "only the small refund reached PayPal");

    const calls = (await judge.req("GET", "/api/calls")).data.reverse();
    assert.deepEqual(
      calls.map((c: { decision: string; agent_name: string }) => [c.decision, c.agent_name]),
      [["allow", "Demo agent"], ["require_approval", "Demo agent"], ["duplicate", "Demo agent"]],
    );
    const pending = (await judge.req("GET", "/api/approvals?status=pending")).data;
    assert.equal(pending.length, 1, "the retry didn't create a second approval");
    assert.equal(pending[0].agent.name, "Demo agent");
    assert.equal(status.approval.status, "pending");

    const approved = await judge.req("POST", `/api/approvals/${pending[0].id}/approve`, {});
    assert.equal(approved.data.status, "executed");
    assert.equal(approved.data.decidedBy, "Demo Approver");
    assert.deepEqual(ctx.demoSent, ["create_refund", "create_refund"]);
    assert.equal((await judge.req("GET", "/api/audit/verify")).data.ok, true);

    assert.deepEqual(ctx.sent, [], "nothing went through the real gate");
    assert.equal(ctx.callLog.recent(10).length, 0);
    assert.equal(ctx.approvals.list().length, 0);
  });

  it("limits runs to one a minute per session", async () => {
    const ctx = await setup({ demoAccess: true });
    const judge = await signInDemo(ctx);
    await runToEnd(judge);
    const again = await judge.req("POST", "/api/demo/run");
    assert.equal(again.status, 429);
    assert.ok(Number(again.headers.get("retry-after")) > 0);
    assert.match(again.data.error, /once a minute/);
  });

  it("is only for the demo account", async () => {
    const ctx = await setup({ demoAccess: true });
    const admin = ctx.browser();
    await admin.signup("Malcolm Clottey", "malcolm@example.com");
    assert.equal((await admin.req("POST", "/api/demo/run")).status, 403);
    assert.equal((await admin.req("GET", "/api/demo/run")).status, 403);
    assert.equal((await fetch(`${ctx.base}/api/demo/run`, { method: "POST" })).status, 401);
  });

  it("gives each demo session its own data, separate from other judges and from real data", async () => {
    const ctx = await setup({ demoAccess: true });
    const admin = ctx.browser();
    await admin.signup("Malcolm Clottey", "malcolm@example.com");
    const realHeld = ctx.heldRefund().id;

    const judgeA = await signInDemo(ctx);
    const judgeB = await signInDemo(ctx);
    await runToEnd(judgeA);

    // B shares the demo account but not A's workspace, and neither sees real data.
    assert.deepEqual((await judgeB.req("GET", "/api/calls")).data, []);
    assert.deepEqual((await judgeB.req("GET", "/api/approvals")).data, []);
    assert.equal((await judgeB.req("GET", `/api/approvals/${realHeld}`)).status, 404);
    assert.equal((await judgeA.req("POST", `/api/approvals/${realHeld}/approve`, {})).status, 404);
    assert.equal((await judgeB.req("GET", "/api/summary")).data.pendingApprovals, 0);

    // Real users don't see demo activity.
    assert.deepEqual((await admin.req("GET", "/api/calls")).data, []);
    assert.deepEqual((await admin.req("GET", "/api/approvals")).data.map((a: { id: string }) => a.id), [realHeld]);
    assert.ok(!(await admin.req("GET", "/api/agent-keys")).data.some((k: { name: string }) => k.name === "Demo agent"));

    // PayPal's webhooks for the demo sale land in that demo workspace, not in real data.
    const refunded = (id: string) => ({
      id,
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "REFUND1",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "5.00" },
        links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/DEMOCAPTURE1" }],
      },
    });
    const post = (event: unknown) => fetch(`${ctx.base}/webhooks/paypal`, { method: "POST", body: JSON.stringify(event) });
    assert.equal((await post(refunded("WH-1"))).status, 200);
    assert.equal((await judgeA.req("GET", "/api/webhooks")).data.length, 1);
    assert.equal(ctx.webhooks.list().length, 0);

    // Once a demo workspace is discarded, late events for its sale are dropped, still not stored as real.
    ctx.demo!.close();
    assert.equal(ctx.demo!.size, 0);
    assert.equal((await post(refunded("WH-2"))).status, 200);
    assert.equal(ctx.webhooks.list().length, 0);
  });
});

describe("auth: agent keys on /mcp", () => {
  const callRefund = (base: string, key: string | null, value = "20.00") =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_refund", arguments: { capture_id: "CAPTURE0000000001", amount: { currency_code: "USD", value } } },
      }),
    });

  it("rejects calls with no key, an invalid key, or a revoked key", async () => {
    const { admin, base, sent } = await team();
    assert.equal((await callRefund(base, null)).status, 401);
    assert.equal((await callRefund(base, "hr_agent_not-a-real-key")).status, 401);
    assert.equal((await callRefund(base, ADMIN_TOKEN)).status, 401, "the admin token is not an agent key");

    const created = await admin.req("POST", "/api/agent-keys", { name: "Support bot" });
    assert.equal((await admin.req("DELETE", `/api/agent-keys/${created.data.key.id}`)).status, 200);
    assert.equal((await callRefund(base, created.data.secret)).status, 401);
    assert.deepEqual(sent, []);
  });

  it("shows a key once, stores only its hash, and records which key made each call", async () => {
    const { admin, base, db, callLog, sent, audit } = await team();
    const created = await admin.req("POST", "/api/agent-keys", { name: "Support bot" });
    const secret: string = created.data.secret;
    assert.match(secret, /^hr_agent_/);

    const listed = await admin.req("GET", "/api/agent-keys");
    assert.ok(!JSON.stringify(listed.data).includes(secret));
    assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM agent_keys`).all()).includes(secret));
    assert.ok(!JSON.stringify(db.prepare(`SELECT data_json FROM audit_chain`).all()).includes(secret));

    const res = await callRefund(base, secret);
    assert.equal(res.status, 200);
    assert.deepEqual(sent, ["create_refund"]);
    const call = callLog.recent(1)[0]!;
    assert.equal(call.agent_name, "Support bot");
    assert.equal(call.agent_key_id, created.data.key.id);
    const decided = audit.list(10, `call:${call.id}`).find((e) => e.kind === "call.decided")!;
    assert.deepEqual(JSON.parse(decided.data_json).agent, { keyId: created.data.key.id, name: "Support bot" });
    assert.equal(audit.verify().ok, true);
  });
});
