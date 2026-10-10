import type { DatabaseSync } from "node:sqlite";
import type { CallFacts, Evaluation, HistoryEntry } from "./policy/types.js";

export interface CallRow {
  id: number;
  created_at: string;
  tool: string;
  args_json: string;
  decision: string;
  reason: string;
  hits_json: string;
  amount_hundredths: number | null;
  currency: string | null;
  amount_source: string;
  forwarded: number;
  approval_id: string | null;
  result_json: string | null;
  is_error: number | null;
  duration_ms: number | null;
}

/**
 * One row per tool call the agent makes: what it asked for, what Handrail
 * decided and why, and what PayPal returned. The hash-chained audit log from
 * the design replaces this in a later step.
 */
export class CallLog {
  constructor(private readonly db: DatabaseSync) {
    migrateStep1Table(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at        TEXT    NOT NULL,
        at_ms             INTEGER NOT NULL,
        tool              TEXT    NOT NULL,
        args_json         TEXT    NOT NULL,
        decision          TEXT    NOT NULL,
        reason            TEXT    NOT NULL,
        hits_json         TEXT    NOT NULL,
        amount_hundredths INTEGER,
        currency          TEXT,
        amount_source     TEXT    NOT NULL,
        forwarded         INTEGER NOT NULL,
        approval_id       TEXT,
        result_json       TEXT,
        is_error          INTEGER,
        duration_ms       INTEGER
      );
      CREATE INDEX IF NOT EXISTS tool_calls_history ON tool_calls (forwarded, at_ms);
    `);
  }

  /**
   * Records a decided call. Synchronous on purpose: evaluating the policy and
   * inserting the row happen with no await in between, so concurrent calls
   * can't both slip under a rate or spend limit.
   */
  begin(facts: CallFacts, evaluation: Evaluation, opts: { forwarded: boolean; approvalId?: string; now: number }): number {
    const result = this.db
      .prepare(
        `INSERT INTO tool_calls (created_at, at_ms, tool, args_json, decision, reason, hits_json,
           amount_hundredths, currency, amount_source, forwarded, approval_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date(opts.now).toISOString(),
        opts.now,
        facts.tool,
        JSON.stringify(facts.args),
        evaluation.decision,
        evaluation.reason,
        JSON.stringify(evaluation.hits),
        facts.amount?.hundredths ?? null,
        facts.amount?.currency ?? null,
        facts.amountSource,
        opts.forwarded ? 1 : 0,
        opts.approvalId ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  finish(id: number, result: unknown, isError: boolean, durationMs: number): void {
    this.db
      .prepare(`UPDATE tool_calls SET result_json = ?, is_error = ?, duration_ms = ? WHERE id = ?`)
      .run(JSON.stringify(result ?? null), isError ? 1 : 0, Math.round(durationMs), id);
  }

  /**
   * Forwarded calls since `sinceMs` that didn't fail, for rate and spend limits.
   * In-flight calls (no result yet) count, so a burst can't exceed a limit.
   */
  history(sinceMs: number): HistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT tool, at_ms, amount_hundredths, currency FROM tool_calls
         WHERE forwarded = 1 AND at_ms > ? AND (is_error IS NULL OR is_error = 0)`,
      )
      .all(sinceMs) as Array<{ tool: string; at_ms: number; amount_hundredths: number | null; currency: string | null }>;
    return rows.map((r) => ({
      tool: r.tool,
      at: r.at_ms,
      amount: r.amount_hundredths !== null && r.currency ? { hundredths: r.amount_hundredths, currency: r.currency } : null,
    }));
  }

  recent(limit: number): CallRow[] {
    return this.db.prepare(`SELECT * FROM tool_calls ORDER BY id DESC LIMIT ?`).all(limit) as unknown as CallRow[];
  }
}

/** Step 1's tool_calls table had no decision columns. Keep its rows under a new name. */
function migrateStep1Table(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((c) => c.name === "decision")) {
    db.exec(`ALTER TABLE tool_calls RENAME TO tool_calls_step1`);
  }
}
