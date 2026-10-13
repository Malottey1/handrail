import type { DatabaseSync } from "node:sqlite";
import { AuditChain } from "./audit-chain.js";
import type { AgentIdentity } from "./auth/agent-keys.js";
import type { Outcome } from "./idempotency.js";
import type { CallFacts, Evaluation, HistoryEntry } from "./policy/types.js";

/** What happened to a call: PayPal's outcome if forwarded, otherwise why not. */
export type CallOutcome = Outcome | "blocked" | "held" | "expired" | "duplicate";

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
  operation_key: string | null;
  request_id: string | null;
  outcome: CallOutcome | null;
  agent_key_id: string | null;
  agent_name: string | null;
}

/**
 * One row per tool call the agent makes: what it asked for, what Handrail
 * decided and why, and what PayPal returned.
 * Every write also appends to the tamper-evident audit chain (audit-chain.ts),
 * in the same transaction; this table is the convenient, queryable view.
 */
export class CallLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly chain = new AuditChain(db),
  ) {
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
    addColumns(db, { operation_key: "TEXT", request_id: "TEXT", outcome: "TEXT", agent_key_id: "TEXT", agent_name: "TEXT" });
  }

  /**
   * Records a decided call. Synchronous on purpose: evaluating the policy and
   * inserting the row happen with no await in between, so concurrent calls
   * can't both slip under a rate or spend limit.
   */
  begin(
    facts: CallFacts,
    evaluation: Evaluation,
    opts: { forwarded: boolean; approvalId?: string; operationKey?: string; requestId?: string; agent?: AgentIdentity | null; now: number },
  ): number {
    return this.chain.record(opts.now, () => {
      const result = this.db
        .prepare(
          `INSERT INTO tool_calls (created_at, at_ms, tool, args_json, decision, reason, hits_json,
             amount_hundredths, currency, amount_source, forwarded, approval_id, operation_key, request_id, agent_key_id, agent_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          opts.operationKey ?? null,
          opts.requestId ?? null,
          opts.agent?.keyId ?? null,
          opts.agent?.name ?? null,
        );
      const id = Number(result.lastInsertRowid);
      const entry = {
        kind: "call.decided" as const,
        ref: `call:${id}`,
        data: {
          tool: facts.tool,
          args: facts.args,
          decision: evaluation.decision,
          reason: evaluation.reason,
          rules: evaluation.hits,
          amount: facts.amount,
          amountSource: facts.amountSource,
          payee: facts.payee,
          forwarded: opts.forwarded,
          approvalId: opts.approvalId ?? null,
          operationKey: opts.operationKey ?? null,
          requestId: opts.requestId ?? null,
          agent: opts.agent ?? null,
        },
      };
      return { value: id, entries: [entry] };
    });
  }

  /** Records a repeat of a live operation that was answered without contacting PayPal. */
  recordDuplicate(tool: string, args: Record<string, unknown>, operationKey: string, now: number, agent: AgentIdentity | null = null): number {
    return this.chain.record(now, () => {
      const result = this.db
        .prepare(
          `INSERT INTO tool_calls (created_at, at_ms, tool, args_json, decision, reason, hits_json,
             amount_source, forwarded, operation_key, outcome, is_error, duration_ms, agent_key_id, agent_name)
           VALUES (?, ?, ?, ?, 'duplicate', 'Repeat of an earlier identical call; not sent to PayPal again', '[]', 'none', 0, ?, 'duplicate', 0, 0, ?, ?)`,
        )
        .run(new Date(now).toISOString(), now, tool, JSON.stringify(args), operationKey, agent?.keyId ?? null, agent?.name ?? null);
      const id = Number(result.lastInsertRowid);
      const data = { tool, args, decision: "duplicate", amount: null, forwarded: false, operationKey, outcome: "duplicate", agent };
      return { value: id, entries: [{ kind: "call.duplicate" as const, ref: `call:${id}`, data }] };
    });
  }

  /**
   * Stores the result. Unknown outcomes are not marked as errors, so they keep
   * counting toward spend limits: the money may have moved.
   */
  finish(id: number, result: unknown, outcome: CallOutcome, durationMs: number, now = Date.now()): void {
    const isError = outcome === "failed" || outcome === "blocked";
    this.chain.record(now, () => {
      this.db
        .prepare(`UPDATE tool_calls SET result_json = ?, is_error = ?, outcome = ?, duration_ms = ? WHERE id = ?`)
        .run(JSON.stringify(result ?? null), isError ? 1 : 0, outcome, Math.round(durationMs), id);
      const data = { outcome, result: result ?? null, durationMs: Math.round(durationMs) };
      return { value: undefined, entries: [{ kind: "call.finished" as const, ref: `call:${id}`, data }] };
    });
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

  /** Forwarded calls of one tool since `sinceMs`, newest first (for webhook matching). */
  forwardedCalls(tool: string, sinceMs: number): CallRow[] {
    return this.db
      .prepare(`SELECT * FROM tool_calls WHERE forwarded = 1 AND tool = ? AND at_ms > ? ORDER BY id DESC`)
      .all(tool, sinceMs) as unknown as CallRow[];
  }

  /** Call counts since `sinceMs` by decision and outcome, for the dashboard summary. */
  counts(sinceMs: number): Array<{ decision: string; outcome: string | null; n: number }> {
    return this.db
      .prepare(`SELECT decision, outcome, count(*) AS n FROM tool_calls WHERE at_ms > ? GROUP BY decision, outcome`)
      .all(sinceMs) as Array<{ decision: string; outcome: string | null; n: number }>;
  }

  /** Every call since `sinceMs`, newest first (context for AI explanations). */
  since(sinceMs: number, limit = 500): CallRow[] {
    return this.db
      .prepare(`SELECT * FROM tool_calls WHERE at_ms > ? ORDER BY id DESC LIMIT ?`)
      .all(sinceMs, limit) as unknown as CallRow[];
  }

  /** The call-log row of a call that's still held for this approval, if any. */
  heldCallFor(approvalId: string): number | null {
    const row = this.db.prepare(`SELECT id FROM tool_calls WHERE approval_id = ? AND outcome = 'held' ORDER BY id LIMIT 1`).get(approvalId) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }

  recent(limit: number): CallRow[] {
    return this.db.prepare(`SELECT * FROM tool_calls ORDER BY id DESC LIMIT ?`).all(limit) as unknown as CallRow[];
  }
}

function addColumns(db: DatabaseSync, columns: Record<string, string>): void {
  const existing = new Set((db.prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE tool_calls ADD COLUMN ${name} ${type}`);
  }
}

/** Step 1's tool_calls table had no decision columns. Keep its rows under a new name. */
function migrateStep1Table(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((c) => c.name === "decision")) {
    db.exec(`ALTER TABLE tool_calls RENAME TO tool_calls_step1`);
  }
}
