import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { ApprovalStore } from "../src/approvals.js";
import { AuditChain, entryHash } from "../src/audit-chain.js";
import { CallLog } from "../src/audit.js";
import type { CallFacts, Evaluation } from "../src/policy/types.js";
import { WebhookStore } from "../src/webhooks.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");

const facts: CallFacts = {
  tool: "create_refund",
  args: { capture_id: "CAP1", amount: { currency_code: "USD", value: "150.00" } },
  amount: { hundredths: 15000, currency: "USD" },
  amountSource: "arguments",
  payee: null,
} as CallFacts;
const held: Evaluation = { decision: "require_approval", reason: "Over 100.00 USD", hits: [] } as unknown as Evaluation;
const allowed: Evaluation = { decision: "allow", reason: "No rule matched", hits: [] } as unknown as Evaluation;

/** A database with one of everything: an allowed call, a held-then-approved call, a duplicate, a webhook. */
function populated() {
  const db = new DatabaseSync(":memory:");
  const audit = new AuditChain(db);
  const callLog = new CallLog(db, audit);
  const approvals = new ApprovalStore(db, audit);
  const webhooks = new WebhookStore(db, audit);

  const a = callLog.begin(facts, allowed, { forwarded: true, now: NOW });
  callLog.finish(a, { content: [{ type: "text", text: '{"id":"R1"}' }] }, "succeeded", 120, NOW + 1);
  callLog.recordDuplicate("create_refund", facts.args, "op-1", NOW + 2);

  const approval = approvals.create(facts, held, NOW + 3, 60_000);
  const h = callLog.begin(facts, held, { forwarded: false, approvalId: approval.id, now: NOW + 3 });
  callLog.finish(h, { handrail: { status: "pending_approval" } }, "held", 0, NOW + 3);
  approvals.decide(approval.id, "executing", "alice", "customer called", NOW + 4);
  approvals.complete(approval.id, "executed", { ok: true }, NOW + 5);

  const event = { id: "WH-1", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "R1" } };
  webhooks.insert(event, true, { status: "matched", tool: "create_refund", callId: a, resourceId: "R1", reasons: [] }, JSON.stringify(event), NOW + 6);

  return { db, audit, callLog, approvals, webhooks, approvalId: approval.id };
}

describe("audit chain", () => {
  it("records every change as a linked entry and verifies clean", () => {
    const { audit } = populated();
    const entries = audit.list(100).reverse();
    assert.deepEqual(
      entries.map((e) => e.kind),
      [
        "chain.started",
        "call.decided",
        "call.finished",
        "call.duplicate",
        "approval.created",
        "call.decided",
        "call.finished",
        "approval.decided",
        "approval.completed",
        "webhook.received",
      ],
    );
    assert.equal(entries[0]!.prev_hash, "0".repeat(64));
    for (let i = 1; i < entries.length; i++) assert.equal(entries[i]!.prev_hash, entries[i - 1]!.hash);

    const result = audit.verify();
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
    assert.equal(result.entries, 10);
    assert.equal(result.head, entries.at(-1)!.hash);
  });

  it("records who approved and why", () => {
    const { audit, approvalId } = populated();
    const decided = audit.list(10, `approval:${approvalId}`).find((e) => e.kind === "approval.decided")!;
    assert.deepEqual(JSON.parse(decided.data_json), {
      decidedBy: "alice",
      decidedById: null,
      decision: "approved",
      note: "customer called",
      status: "executing",
    });
  });

  it("refuses to update or delete entries", () => {
    const { db } = populated();
    assert.throws(() => db.exec(`UPDATE audit_chain SET kind = 'x' WHERE seq = 2`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM audit_chain WHERE seq = 2`), /append-only/);
  });

  it("detects an edited entry, even with the triggers dropped", () => {
    const { db, audit } = populated();
    db.exec(`DROP TRIGGER audit_chain_no_update`);
    db.exec(`UPDATE audit_chain SET data_json = replace(data_json, '"allow"', '"block"') WHERE seq = 2`);
    const result = audit.verify();
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.seq === 2 && /edited/.test(p.problem)));
  });

  it("detects an edit that recomputes the entry's own hash, because the next link breaks", () => {
    const { db, audit } = populated();
    db.exec(`DROP TRIGGER audit_chain_no_update`);
    const row = db.prepare(`SELECT * FROM audit_chain WHERE seq = 2`).get() as Record<string, any>;
    const data = row.data_json.replace('"allow"', '"block"');
    db.prepare(`UPDATE audit_chain SET data_json = ?, hash = ? WHERE seq = 2`).run(
      data,
      entryHash(row.prev_hash, row.seq, row.at, row.kind, row.ref, data),
    );
    const result = audit.verify();
    assert.ok(result.problems.some((p) => p.seq === 3 && /link is broken/.test(p.problem)));
  });

  it("detects a removed entry", () => {
    const { db, audit } = populated();
    db.exec(`DROP TRIGGER audit_chain_no_delete`);
    db.exec(`DELETE FROM audit_chain WHERE seq = 4`);
    const result = audit.verify();
    assert.ok(result.problems.some((p) => p.seq === 5 && /missing or reordered/.test(p.problem)));
  });

  it("detects edits to the working tables the dashboard reads", () => {
    const { db, audit, approvalId } = populated();
    db.exec(`UPDATE tool_calls SET decision = 'allow' WHERE decision = 'require_approval'`);
    db.prepare(`UPDATE approvals SET decided_by = 'mallory' WHERE id = ?`).run(approvalId);
    db.exec(`UPDATE webhook_events SET raw_json = replace(raw_json, 'R1', 'R2')`);
    const problems = audit.verify().problems.map((p) => p.problem);
    assert.ok(problems.includes("tool_calls decision differs from the audit log"));
    assert.ok(problems.includes("approvals decided_by differs from the audit log"));
    assert.ok(problems.includes("webhook_events raw event differs from the audit log"));
  });

  it("detects a call inserted behind Handrail's back", () => {
    const { db, audit } = populated();
    db.exec(`INSERT INTO tool_calls (created_at, at_ms, tool, args_json, decision, reason, hits_json, amount_source, forwarded)
             VALUES ('x', 0, 'create_refund', '{}', 'allow', 'x', '[]', 'none', 1)`);
    assert.ok(audit.verify().problems.some((p) => /no audit entry/.test(p.problem)));
  });

  it("doesn't flag rows from before the chain existed", () => {
    const db = new DatabaseSync(":memory:");
    const plain = new CallLog(db, { record: (_now: number, change: () => { value: number }) => change().value } as unknown as AuditChain);
    plain.begin(facts, allowed, { forwarded: true, now: NOW }); // written without the chain, like old data

    const callLog = new CallLog(db, new AuditChain(db));
    callLog.begin(facts, allowed, { forwarded: true, now: NOW + 1 });
    const result = new AuditChain(db).verify();
    assert.deepEqual(result.problems, []);
    assert.equal(JSON.parse(new AuditChain(db).list(100).at(-1)!.data_json).toolCallsBefore, 1);
  });

  it("writes nothing when the change fails", () => {
    const { audit } = populated();
    const before = audit.verify().entries;
    assert.throws(() =>
      audit.record(NOW, () => {
        throw new Error("boom");
      }),
    );
    assert.equal(audit.verify().entries, before);
  });
});
