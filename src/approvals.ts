import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AuditChain } from "./audit-chain.js";
import type { CallFacts, Evaluation } from "./policy/types.js";

/**
 * pending   -> waiting for a human
 * executing -> approved, being forwarded to PayPal
 * executed  -> approved and forwarded; PayPal's result is stored
 * failed    -> approved and forwarded, but PayPal returned an error
 * blocked   -> approved, but the policy now blocks it (e.g. a limit was hit meanwhile)
 * rejected  -> a human said no
 * expired   -> nobody decided in time
 */
export type ApprovalStatus = "pending" | "executing" | "executed" | "failed" | "blocked" | "rejected" | "expired";

export const FINAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set(["executed", "failed", "blocked", "rejected", "expired"]);

export interface Approval {
  id: string;
  createdAt: number;
  expiresAt: number;
  tool: string;
  args: Record<string, unknown>;
  facts: CallFacts;
  evaluation: Evaluation;
  status: ApprovalStatus;
  decidedAt: number | null;
  decidedBy: string | null;
  note: string | null;
  result: unknown;
}

interface ApprovalRow {
  id: string;
  created_at: number;
  expires_at: number;
  tool: string;
  facts_json: string;
  evaluation_json: string;
  status: ApprovalStatus;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
  result_json: string | null;
}

/** Every change is also appended to the audit chain, in the same transaction. */
export class ApprovalStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly chain = new AuditChain(db),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id              TEXT    PRIMARY KEY,
        created_at      INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL,
        tool            TEXT    NOT NULL,
        facts_json      TEXT    NOT NULL,
        evaluation_json TEXT    NOT NULL,
        status          TEXT    NOT NULL,
        decided_at      INTEGER,
        decided_by      TEXT,
        note            TEXT,
        result_json     TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, expires_at);
    `);
  }

  create(facts: CallFacts, evaluation: Evaluation, now: number, ttlMs: number): Approval {
    const id = `apr_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    this.chain.record(now, () => {
      this.db
        .prepare(
          `INSERT INTO approvals (id, created_at, expires_at, tool, facts_json, evaluation_json, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(id, now, now + ttlMs, facts.tool, JSON.stringify(facts), JSON.stringify(evaluation));
      const data = { tool: facts.tool, facts, evaluation, status: "pending", expiresAt: new Date(now + ttlMs).toISOString() };
      return { value: undefined, entries: [{ kind: "approval.created" as const, ref: `approval:${id}`, data }] };
    });
    return this.get(id)!;
  }

  get(id: string): Approval | null {
    const row = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(status?: ApprovalStatus, limit = 100): Approval[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit)
      : this.db.prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`).all(limit);
    return (rows as unknown as ApprovalRow[]).map(fromRow);
  }

  /**
   * Moves a pending, unexpired approval to `to` and records who decided.
   * Returns false if it wasn't pending (already decided, or expired), so two
   * clicks on Approve can never execute a call twice.
   */
  decide(id: string, to: "executing" | "rejected", by: string, note: string | null, now: number): boolean {
    return this.chain.record(now, () => {
      const changed =
        this.db
          .prepare(
            `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, note = ?
             WHERE id = ? AND status = 'pending' AND expires_at > ?`,
          )
          .run(to, now, by, note, id, now).changes === 1;
      const data = { status: to, decidedBy: by, note, decision: to === "executing" ? "approved" : "rejected" };
      return { value: changed, entries: changed ? [{ kind: "approval.decided" as const, ref: `approval:${id}`, data }] : [] };
    });
  }

  /** Records the outcome of an approved call. */
  complete(id: string, status: "executed" | "failed" | "blocked", result: unknown, now = Date.now()): void {
    this.chain.record(now, () => {
      this.db.prepare(`UPDATE approvals SET status = ?, result_json = ? WHERE id = ?`).run(status, JSON.stringify(result ?? null), id);
      const data = { status, result: result ?? null };
      return { value: undefined, entries: [{ kind: "approval.completed" as const, ref: `approval:${id}`, data }] };
    });
  }

  /** Marks overdue pending approvals expired. Returns the ids it expired. */
  expireOverdue(now: number): string[] {
    // Cheap check first: this runs on every call, and most of the time there's nothing to expire.
    const overdue = this.db.prepare(`SELECT 1 FROM approvals WHERE status = 'pending' AND expires_at <= ? LIMIT 1`).get(now);
    if (!overdue) return [];
    return this.chain.record(now, () => {
      const ids = (
        this.db.prepare(`SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ?`).all(now) as Array<{ id: string }>
      ).map((r) => r.id);
      this.db.prepare(`UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?`).run(now, now);
      const entries = ids.map((id) => ({ kind: "approval.expired" as const, ref: `approval:${id}`, data: { status: "expired" } }));
      return { value: ids, entries };
    });
  }
}

function fromRow(row: ApprovalRow): Approval {
  const facts = JSON.parse(row.facts_json) as CallFacts;
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    tool: row.tool,
    args: facts.args,
    facts,
    evaluation: JSON.parse(row.evaluation_json) as Evaluation,
    status: row.status,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    note: row.note,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}
