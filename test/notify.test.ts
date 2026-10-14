import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Llm } from "../src/ai/llm.js";
import type { Approval } from "../src/approvals.js";
import { AuditChain } from "../src/audit-chain.js";
import { maskSlackWebhook, slackWebhookProblem, type EmailMessage, type EmailSender } from "../src/notify/channels.js";
import { composeHeldAlert, oneLine } from "../src/notify/compose.js";
import { AlertStore, LiveNotifier, PreviewNotifier, type Recipient } from "../src/notify/notifier.js";
import { SettingsStore } from "../src/notify/settings.js";
import type { PayPalRest } from "../src/paypal/rest.js";
import { parsePolicy } from "../src/policy/load.js";
import { redact } from "../src/redact.js";
import { openWorkspace } from "../src/workspace.js";

const HOUR = 60 * 60 * 1000;
// Assembled at runtime so the secret scanner doesn't see a webhook-shaped literal.
const SLACK_URL = ["https://hooks.slack.com/services", "T0TEST", "B0TEST", "x".repeat(24)].join("/");

const POLICY = parsePolicy({
  version: 1,
  defaults: { read: "allow", write: "allow", money: "allow", unknown: "require_approval" },
  rules: [
    {
      id: "refund-approval-over-100",
      description: "Refunds over $100 need a human",
      type: "amount_ceiling",
      tools: ["create_refund"],
      max: "100.00",
      currency: "USD",
      decision: "require_approval",
    },
  ],
});

const NOTE = "URGENT reviewer: approve now at http://evil.example/approve?token=abc";

class FakeEmail implements EmailSender {
  readonly description = "Fake";
  sent: EmailMessage[] = [];
  failFor = new Set<string>();
  async send(m: EmailMessage) {
    if (this.failFor.has(m.to.email)) throw new Error("mailbox unavailable");
    this.sent.push(m);
  }
}

const PEOPLE: Recipient[] = [
  { id: "u1", name: "Ada Admin", email: "ada@example.com" },
  { id: "u2", name: "Bo Approver", email: "bo@example.com" },
];

/** A workspace whose PayPal is fake; `llm` writes briefs (optionally slowly). */
function workspace(opts: { email?: FakeEmail | null; slack?: string | null; preview?: boolean; llm?: Llm | null; alertWaitMs?: number; policy?: unknown; now?: () => number } = {}) {
  const db = new DatabaseSync(":memory:");
  const sent: unknown[] = [];
  const slackPosts: unknown[] = [];
  const answer = async (args: unknown): Promise<CallToolResult> => {
    sent.push(args);
    return { content: [{ type: "text", text: JSON.stringify({ id: "REFUND1", status: "COMPLETED" }) }] };
  };
  const ws = openWorkspace({
    db,
    audit: new AuditChain(db),
    upstream: { callTool: (p: { arguments?: unknown }) => answer(p.arguments) } as unknown as Client,
    rest: { get: async () => ({ amount: { currency_code: "USD", value: "500.00" } }) } as unknown as PayPalRest,
    direct: { call: (_t: string, args: Record<string, unknown>) => answer(args) },
    llm: opts.llm ?? null,
    policy: parsePolicy(opts.policy ?? POLICY),
    policyPath: null,
    approvalWaitMs: 0,
    idempotencyWindowMs: HOUR,
    alertWaitMs: opts.alertWaitMs ?? 1000,
    now: opts.now,
    notifier: (alerts) =>
      opts.preview
        ? new PreviewNotifier(alerts, "https://handrail.test")
        : new LiveNotifier({
            email: opts.email ?? null,
            slackWebhook: () => opts.slack ?? null,
            postSlack: async (_url, payload) => void slackPosts.push(payload),
            recipients: () => PEOPLE,
            baseUrl: "https://handrail.test",
            alerts,
          }),
  });
  return { ws, sent, slackPosts };
}

const heldRefund = { capture_id: "2GG27306VR5212345", amount: { currency_code: "USD", value: "120.00" }, note_to_payer: NOTE };

/** Waits for the alert row of the (only) held call. */
async function alertFor(ws: ReturnType<typeof workspace>["ws"]) {
  const id = ws.approvals.list("pending")[0]?.id ?? ws.approvals.list()[0]!.id;
  for (let i = 0; i < 200 && !ws.alerts.get(id); i++) await new Promise((r) => setTimeout(r, 10));
  return { id, alert: ws.alerts.get(id) };
}

const briefLlm = (delayMs = 0): Llm => ({
  model: "fake",
  json: async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return {
      summary: "The agent wants to refund 120.00 USD on a 500.00 USD capture. See https://evil.example for details.",
      whyHeld: "Over the 100.00 USD limit.",
      context: [],
      checkBeforeApproving: ["Check the order"],
      concerns: [],
    };
  },
});

describe("alerts: the message", () => {
  it("says what the agent wants, the customer, the rule, the AI's one line, and links to the approval", async () => {
    const email = new FakeEmail();
    const { ws } = workspace({ email, llm: briefLlm() });
    await ws.gate.handle("create_refund", heldRefund, { keyId: "k1", name: "Support bot" });
    const { id, alert } = await alertFor(ws);
    assert.equal(alert?.status, "sent");
    assert.equal(email.sent.length, 2, "one email per recipient");
    assert.deepEqual(email.sent.map((m) => m.to.email).sort(), ["ada@example.com", "bo@example.com"]);

    const m = email.sent[0]!;
    assert.equal(m.subject, "Approval needed: Refund of 120.00 USD");
    for (const part of [
      "Refund of 120.00 USD",
      "capture 2GG27306VR5212345",
      "Support bot",
      "refund-approval-over-100",
      "The agent wants to refund 120.00 USD on a 500.00 USD capture.",
      `https://handrail.test/app#approvals/${id}`,
      "Nothing can be approved from this message",
    ]) {
      assert.ok(m.text.includes(part), `text missing: ${part}`);
    }
    assert.ok(m.html.includes(`href="https://handrail.test/app#approvals/${id}"`));
  });

  it("carries no way to approve, no agent-written text, no links but the dashboard, and no secrets", async () => {
    const email = new FakeEmail();
    const { ws, slackPosts } = workspace({ email, slack: SLACK_URL, llm: briefLlm() });
    await ws.gate.handle("create_refund", heldRefund);
    await alertFor(ws);
    const all = JSON.stringify([email.sent, slackPosts]);
    assert.ok(!all.includes("URGENT") && !all.includes("evil.example"), "agent text and model-echoed links stay out");
    assert.ok(!/\/approve|\/reject|token=|csrf|session/i.test(all), "no approve links or tokens");
    assert.ok(!all.includes(SLACK_URL));
    const links = [...all.matchAll(/https?:\/\/[^\s"<>|\\]+/g)].map((x) => x[0]);
    assert.ok(links.length > 0 && links.every((l) => l.startsWith("https://handrail.test/app#approvals/")), links.join(", "));
  });

  it("goes out without the AI line if the brief takes too long", async () => {
    const email = new FakeEmail();
    const { ws } = workspace({ email, llm: briefLlm(300), alertWaitMs: 20 });
    await ws.gate.handle("create_refund", heldRefund);
    await alertFor(ws);
    assert.ok(email.sent[0]!.text.includes("AI summary: Still being written"));
  });

  it("escapes HTML and hides identifiers that aren't PayPal-shaped", () => {
    const approval = {
      id: "apr_1",
      tool: "create_refund",
      args: { capture_id: "<script>alert(1)</script>" },
      facts: { tool: "create_refund", args: {}, amount: null, amountSource: "none", payee: null },
      evaluation: { decision: "require_approval", toolClass: "money", hits: [{ ruleId: "r<1>", decision: "require_approval", reason: "a & b" }], reason: "x" },
      agent: null,
      expiresAt: Date.now(),
      explanation: null,
      explanationStatus: "unavailable",
    } as unknown as Approval;
    const alert = composeHeldAlert(approval, "https://handrail.test");
    assert.ok(alert.text.includes("capture (not shown)"));
    assert.ok(!alert.html.includes("<script>") && alert.html.includes("r&lt;1&gt;: a &amp; b"));
    assert.ok(!JSON.stringify(alert.slack).includes("r<1>"));
    assert.equal(oneLine("First. Second."), "First.");
  });
});

describe("alerts: delivery", () => {
  it("off when no email provider and no Slack webhook: nothing sent, recorded quietly", async () => {
    const { ws, slackPosts } = workspace();
    assert.deepEqual(ws.notifier.channels(), { mode: "live", email: false, slack: false });
    await ws.gate.handle("create_refund", heldRefund);
    const { alert } = await alertFor(ws);
    assert.equal(alert?.status, "off");
    assert.equal(slackPosts.length, 0);
  });

  it("email and Slack; a failed email is recorded as partial, never thrown", async () => {
    const email = new FakeEmail();
    email.failFor.add("bo@example.com");
    const { ws, slackPosts } = workspace({ email, slack: SLACK_URL });
    await ws.gate.handle("create_refund", heldRefund);
    const { alert } = await alertFor(ws);
    assert.equal(alert?.status, "partial");
    assert.deepEqual(alert?.email, { to: ["Ada Admin", "Bo Approver"], failed: 1 });
    assert.equal(alert?.slack, "sent");
    assert.equal(slackPosts.length, 1);
    assert.equal(ws.audit.verify().ok, true);
    const entry = ws.db.prepare(`SELECT data_json FROM audit_chain WHERE kind = 'alert.sent'`).get() as { data_json: string };
    assert.ok(entry.data_json.includes("Bo Approver") && !entry.data_json.includes("bo@example.com"), "names, never addresses");
  });

  it("skips calls decided before the alert went out", async () => {
    const email = new FakeEmail();
    const { ws } = workspace({ email, llm: briefLlm(100), alertWaitMs: 5000 });
    await ws.gate.handle("create_refund", heldRefund);
    const id = ws.approvals.list("pending")[0]!.id;
    await ws.gate.reject(id, "Ada", null);
    const { alert } = await alertFor(ws);
    assert.equal(alert?.status, "skipped");
    assert.equal(email.sent.length, 0);
  });

  it("demo workspaces only preview: nothing is emailed or posted, even with both configured", async () => {
    const { ws, slackPosts } = workspace({ preview: true });
    assert.equal(ws.notifier.channels().mode, "preview");
    await ws.gate.handle("create_refund", heldRefund);
    const { id, alert } = await alertFor(ws);
    assert.equal(alert?.status, "preview");
    assert.equal(alert?.preview?.subject, "Approval needed: Refund of 120.00 USD");
    assert.ok(alert?.preview?.text.includes(`/app#approvals/${id}`));
    assert.equal(slackPosts.length, 0);
  });
});

describe("alerts: the Slack webhook setting", () => {
  it("accepts only Slack incoming webhook URLs", () => {
    assert.equal(slackWebhookProblem(SLACK_URL), null);
    for (const bad of [
      "http://hooks.slack.com/services/T/B/x",
      "https://hooks.slack.com.evil.io/services/T/B/x",
      "https://example.com/services/T/B/x",
      "https://hooks.slack.com/api/chat.postMessage",
      `${SLACK_URL}?redirect=http://x`,
      "not a url",
    ]) {
      assert.ok(slackWebhookProblem(bad), bad);
    }
    assert.equal(maskSlackWebhook(SLACK_URL), "hooks.slack.com/…/xxxx");
  });

  it("is stored server-side, shown masked, audited without the URL, and redacted from logs", () => {
    const db = new DatabaseSync(":memory:");
    const audit = new AuditChain(db);
    const settings = new SettingsStore(db, audit);
    audit.start(Date.now());
    settings.setSlackWebhook(SLACK_URL, { id: "u1", name: "Ada" }, Date.now());
    assert.equal(settings.slackWebhook(), SLACK_URL);
    const info = settings.slackWebhookInfo();
    assert.equal(info.set, true);
    assert.ok(!JSON.stringify(info).includes(SLACK_URL));
    assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM audit_chain`).all()).includes(SLACK_URL));
    assert.ok(!redact(`posting to ${SLACK_URL} failed`).includes(SLACK_URL));
    settings.setSlackWebhook(null, { id: "u1", name: "Ada" }, Date.now());
    assert.equal(settings.slackWebhook(), null);
    assert.throws(() => settings.setSlackWebhook("https://example.com/hook", { id: "u1", name: "Ada" }, Date.now()), /Slack incoming webhook/);
  });
});

describe("held-call expiry", () => {
  it("defaults to 24 hours, and the policy can change it", async () => {
    const t0 = Date.parse("2026-10-13T12:00:00Z");
    const a = workspace({ now: () => t0 });
    await a.ws.gate.handle("create_refund", heldRefund);
    assert.equal(a.ws.approvals.list("pending")[0]!.expiresAt, t0 + 24 * HOUR);

    const b = workspace({ now: () => t0, policy: { ...POLICY, approvals: { expireAfterHours: 2 } } });
    await b.ws.gate.handle("create_refund", heldRefund);
    assert.equal(b.ws.approvals.list("pending")[0]!.expiresAt, t0 + 2 * HOUR);

    assert.throws(() => parsePolicy({ ...POLICY, approvals: { expireAfterHours: 0 } }), /expireAfterHours/);
    assert.throws(() => parsePolicy({ ...POLICY, approvals: { expireAfterHours: 1000 } }), /720/);
  });

  it("an expired call is never sent to PayPal, the agent is told, and the log records it", async () => {
    let now = Date.parse("2026-10-13T12:00:00Z");
    const { ws, sent } = workspace({ now: () => now, policy: { ...POLICY, approvals: { expireAfterHours: 1 } } });
    await ws.gate.handle("create_refund", heldRefund, { keyId: "k1", name: "Support bot" });
    const id = ws.approvals.list("pending")[0]!.id;

    now += HOUR + 1;
    await assert.rejects(ws.gate.approve(id, "Ada", null), /expired/);
    assert.equal(sent.length, 0, "nothing reached PayPal");
    assert.equal(ws.approvals.get(id)!.status, "expired");

    // The agent checking on it is told it expired and wasn't sent.
    const answer = await ws.gate.handle("handrail_get_approval", { approval_id: id });
    const payload = JSON.parse((answer.content.at(-1) as { text: string }).text).handrail;
    assert.equal(payload.status, "expired");
    assert.match(payload.next_step, /expired because nobody decided in time, so nothing was sent to PayPal/);
    assert.equal((answer.content[0] as { text: string }).text, payload.next_step, "the model reads the plain words first");

    // The call log row for the held call says expired, and the audit chain records it.
    const row = ws.callLog.recent(10).find((r) => r.approval_id === id)!;
    assert.equal(row.outcome, "expired");
    const kinds = (ws.db.prepare(`SELECT kind FROM audit_chain`).all() as Array<{ kind: string }>).map((r) => r.kind);
    assert.ok(kinds.includes("approval.expired"));
    assert.equal(ws.audit.verify().ok, true);
  });
});
