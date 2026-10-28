import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "./idempotency.js";

/**
 * call.decided       a call was evaluated (decision, reason, facts, whether it was forwarded)
 * call.duplicate     a repeat answered without contacting PayPal
 * call.finished      PayPal's result, or why the call was not forwarded
 * approval.created   a call was held for a human
 * approval.decided   a human approved or rejected it
 * approval.completed the approved call's outcome
 * approval.expired   nobody decided in time
 * approval.explained the AI explanation shown to the reviewer (advisory only)
 * webhook.received   a PayPal event and what it was matched to
 * policy.loaded      the policy in force at startup (when it differs from the last one recorded)
 * policy.changed     a human changed the policy from the dashboard
 * user.created       an account was created (first admin, by invite, or the demo account)
 * user.updated       a profile, password (never the hash), role or access change
 * invite.created     an admin invited someone, with a role
 * invite.revoked     an admin cancelled an unused invite
 * agent_key.created  an admin created an agent API key (its prefix, never the key)
 * agent_key.revoked  an admin revoked an agent key
 * alert.sent         a held-call alert: who was emailed (names only), Slack, or why nothing was sent
 * settings.changed   an admin changed a setting (the Slack webhook: set or removed, never the URL)
 */
export type AuditKind =
  | "chain.started"
  | "call.decided"
  | "call.duplicate"
  | "call.finished"
  | "approval.created"
  | "approval.decided"
  | "approval.completed"
  | "approval.expired"
  | "approval.explained"
  | "webhook.received"
  | "policy.loaded"
  | "policy.changed"
  | "user.created"
  | "user.updated"
  | "invite.created"
  | "invite.revoked"
  | "agent_key.created"
  | "agent_key.revoked"
  | "alert.sent"
  | "settings.changed";

export interface AuditEntry {
  kind: AuditKind;
  /** What the entry is about: call:<id>, approval:<id>, webhook:<event id>. */
  ref: string;
  data: Record<string, unknown>;
}

export interface AuditRow {
  seq: number;
  at: string;
  kind: AuditKind;
  ref: string;
  data_json: string;
  prev_hash: string;
  hash: string;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** Hash of the newest entry. Writing it down elsewhere also detects a truncated log. */
  head: string;
  problems: Array<{ seq: number | null; ref: string | null; problem: string }>;
}

const GENESIS = "0".repeat(64);

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function entryHash(prev: string, seq: number, at: string, kind: string, ref: string, dataJson: string): string {
  return sha256([prev, seq, at, kind, ref, dataJson].join("\n"));
}

/**
 * Tamper-evident audit log. Append-only: each entry's hash covers the previous
 * entry's hash, so editing, removing or reordering any entry breaks every hash
 * after it. Triggers reject UPDATE and DELETE; the hashes catch anyone who
 * drops the triggers or edits the file directly.
 *
 * The working tables (tool_calls, approvals, webhook_events) stay mutable for
 * convenience. verify() checks that they still agree with the chain.
 */
export class AuditChain {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_chain (
        seq       INTEGER PRIMARY KEY,
        at        TEXT    NOT NULL,
        kind      TEXT    NOT NULL,
        ref       TEXT    NOT NULL,
        data_json TEXT    NOT NULL,
        prev_hash TEXT    NOT NULL,
        hash      TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_chain_ref ON audit_chain (ref);
      CREATE TRIGGER IF NOT EXISTS audit_chain_no_update BEFORE UPDATE ON audit_chain
        BEGIN SELECT RAISE(ABORT, 'audit_chain is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_chain_no_delete BEFORE DELETE ON audit_chain
        BEGIN SELECT RAISE(ABORT, 'audit_chain is append-only'); END;
    `);
  }

  /**
   * Runs `change` (writes to a working table) and appends the entries that
   * describe it, in one transaction: a row never exists without its entry.
   * IMMEDIATE locks out other processes sharing the file (e.g. stdio scripts),
   * so two writers can't both chain onto the same head.
   */
  record<T>(now: number, change: () => { value: T; entries: AuditEntry[] }): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureStarted(now); // before the change, so its snapshot excludes the row being written
      const { value, entries } = change();
      for (const entry of entries) this.appendRow(entry, now);
      this.db.exec("COMMIT");
      return value;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Writes the first entry if the log is empty, snapshotting which rows
   * already exist. Called at startup, after the working tables are created.
   */
  start(now: number): void {
    this.record(now, () => ({ value: undefined, entries: [] }));
  }

  append(entry: AuditEntry, now: number): void {
    this.record(now, () => ({ value: undefined, entries: [entry] }));
  }

  /** Newest first; `since` (ISO time) and `beforeSeq` narrow it for paging back. */
  list(limit = 100, ref?: string, { since, beforeSeq }: { since?: string; beforeSeq?: number } = {}): AuditRow[] {
    const where = ["seq < ?", "at >= ?"];
    const args: Array<string | number> = [beforeSeq ?? Number.MAX_SAFE_INTEGER, since ?? ""];
    if (ref) {
      where.push("ref = ?");
      args.push(ref);
    }
    return this.db
      .prepare(`SELECT * FROM audit_chain WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`)
      .all(...args, limit) as unknown as AuditRow[];
  }

  /** The oldest entry, for "first entry" on the dashboard. */
  first(): AuditRow | null {
    return (this.db.prepare(`SELECT * FROM audit_chain ORDER BY seq LIMIT 1`).get() as unknown as AuditRow | undefined) ?? null;
  }

  /** Recomputes every hash, then checks the working tables against the chain. */
  verify(): VerifyResult {
    const problems: VerifyResult["problems"] = [];
    const rows = this.db.prepare(`SELECT * FROM audit_chain ORDER BY seq`).all() as unknown as AuditRow[];

    let prev = GENESIS;
    rows.forEach((row, i) => {
      if (row.seq !== i + 1) problems.push({ seq: row.seq, ref: row.ref, problem: `expected entry #${i + 1}; entries are missing or reordered` });
      if (row.prev_hash !== prev) problems.push({ seq: row.seq, ref: row.ref, problem: "previous-hash link is broken" });
      if (entryHash(row.prev_hash, row.seq, row.at, row.kind, row.ref, row.data_json) !== row.hash) {
        problems.push({ seq: row.seq, ref: row.ref, problem: "contents don't match the entry's hash (edited)" });
      }
      prev = row.hash;
    });

    problems.push(...checkWorkingTables(this.db, rows));
    return { ok: problems.length === 0, entries: rows.length, head: prev, problems };
  }

  private head(): { seq: number; hash: string } {
    const row = this.db.prepare(`SELECT seq, hash FROM audit_chain ORDER BY seq DESC LIMIT 1`).get() as
      | { seq: number; hash: string }
      | undefined;
    return row ?? { seq: 0, hash: GENESIS };
  }

  private appendRow(entry: AuditEntry, now: number): void {
    const { seq, hash: prev } = this.head();
    const at = new Date(now).toISOString();
    const dataJson = canonicalJson(entry.data);
    this.db
      .prepare(`INSERT INTO audit_chain (seq, at, kind, ref, data_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(seq + 1, at, entry.kind, entry.ref, dataJson, prev, entryHash(prev, seq + 1, at, entry.kind, entry.ref, dataJson));
  }

  /**
   * The first entry records which working-table rows already existed, so
   * verify() doesn't flag rows from before the chain as unrecorded.
   */
  private ensureStarted(now: number): void {
    if (this.head().seq > 0) return;
    const column = (table: string, sql: string) =>
      tableExists(this.db, table) ? (this.db.prepare(sql).all() as Array<{ v: string | number | null }>).map((r) => r.v) : [];
    this.appendRow(
      {
        kind: "chain.started",
        ref: "chain",
        data: {
          toolCallsBefore: column("tool_calls", `SELECT max(id) AS v FROM tool_calls`)[0] ?? 0,
          approvalsBefore: column("approvals", `SELECT id AS v FROM approvals ORDER BY id`),
          webhooksBefore: column("webhook_events", `SELECT event_id AS v FROM webhook_events ORDER BY event_id`),
        },
      },
      now,
    );
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const parse = (json: string | null) => (json === null ? null : JSON.parse(json));

/**
 * Replays the chain into the state each working-table row should have, and
 * reports rows that differ, or that exist with no entry at all.
 */
function checkWorkingTables(db: DatabaseSync, rows: AuditRow[]): VerifyResult["problems"] {
  const problems: VerifyResult["problems"] = [];
  const started = rows.find((r) => r.kind === "chain.started");
  const before = started
    ? (JSON.parse(started.data_json) as { toolCallsBefore: number; approvalsBefore: string[]; webhooksBefore: string[] })
    : null; // nothing recorded yet: every existing row predates the log
  if (!before) return problems;

  // Expected state per ref, built by applying entries in order.
  const expected = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    expected.set(row.ref, { ...expected.get(row.ref), ...data });
  }

  const flag = (ref: string, problem: string) => problems.push({ seq: null, ref, problem });

  if (tableExists(db, "tool_calls")) {
    for (const row of db.prepare(`SELECT * FROM tool_calls`).all() as Array<Record<string, any>>) {
      const ref = `call:${row.id}`;
      const want = expected.get(ref);
      if (!want) {
        if (row.id > before.toolCallsBefore) flag(ref, "row has no audit entry (inserted outside Handrail)");
        continue;
      }
      const amount = row.amount_hundredths !== null ? { hundredths: row.amount_hundredths, currency: row.currency } : null;
      const checks: Array<[string, boolean]> = [
        ["tool", row.tool === want.tool],
        ["arguments", same(parse(row.args_json), want.args)],
        ["decision", row.decision === want.decision],
        ["amount", same(amount, want.amount)],
        ["forwarded", Boolean(row.forwarded) === want.forwarded],
        ["outcome", (row.outcome ?? null) === (want.outcome ?? null)],
        ["result", same(parse(row.result_json), want.result)],
        ["agent", same(row.agent_name ? { keyId: row.agent_key_id ?? null, name: row.agent_name } : null, want.agent)],
      ];
      for (const [field, ok] of checks) if (!ok) flag(ref, `tool_calls ${field} differs from the audit log`);
    }
  }

  if (tableExists(db, "approvals")) {
    for (const row of db.prepare(`SELECT * FROM approvals`).all() as Array<Record<string, any>>) {
      const ref = `approval:${row.id}`;
      const want = expected.get(ref);
      if (!want) {
        if (!before.approvalsBefore.includes(row.id)) flag(ref, "row has no audit entry (inserted outside Handrail)");
        continue;
      }
      const checks: Array<[string, boolean]> = [
        ["tool", row.tool === want.tool],
        ["facts", same(parse(row.facts_json), want.facts)],
        ["status", row.status === want.status],
        ["decided_by", (row.decided_by ?? null) === (want.decidedBy ?? null)],
        ["decided_by_id", (row.decided_by_id ?? null) === (want.decidedById ?? null)],
        ["agent", same(parse(row.agent_json ?? null), want.agent)],
        ["note", (row.note ?? null) === (want.note ?? null)],
        ["result", same(parse(row.result_json), want.result)],
        ["explanation", !("explanation" in want) || same(parse(row.explanation_json), want.explanation)],
      ];
      for (const [field, ok] of checks) if (!ok) flag(ref, `approvals ${field} differs from the audit log`);
    }
  }

  if (tableExists(db, "webhook_events")) {
    for (const row of db.prepare(`SELECT * FROM webhook_events`).all() as Array<Record<string, any>>) {
      const ref = `webhook:${row.event_id}`;
      const want = expected.get(ref);
      if (!want) {
        if (!before.webhooksBefore.includes(row.event_id)) flag(ref, "row has no audit entry (inserted outside Handrail)");
        continue;
      }
      const checks: Array<[string, boolean]> = [
        ["status", row.status === want.status],
        ["call_id", (row.call_id ?? null) === (want.callId ?? null)],
        ["verified", Boolean(row.verified) === want.verified],
        ["raw event", sha256(row.raw_json) === want.rawSha256],
      ];
      for (const [field, ok] of checks) if (!ok) flag(ref, `webhook_events ${field} differs from the audit log`);
    }
  }

  return problems;
}
