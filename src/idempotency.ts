import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { classifyTool } from "./policy/classify.js";

/** Optional argument agents can add to any non-read tool. Stripped before forwarding. */
export const IDEMPOTENCY_ARG = "idempotency_key";

/**
 * in_flight        being sent to PayPal now
 * pending_approval held for a human
 * succeeded        PayPal accepted it; repeats get the stored result
 * failed           PayPal definitely rejected it (4xx); a repeat is a fresh attempt
 * unknown          no answer (timeout, 5xx, dropped connection); it may have run
 * rejected         a human said no; repeats get the same rejection
 * abandoned        approval expired or the policy blocked it at approval; a repeat is a fresh attempt
 */
export type OperationStatus = "in_flight" | "pending_approval" | "succeeded" | "failed" | "unknown" | "rejected" | "abandoned";

export type Outcome = "succeeded" | "failed" | "unknown";

export interface Operation {
  key: string;
  tool: string;
  explicit: boolean;
  createdAt: number;
  /** After this, an identical call (derived key only) counts as a new operation. Null for explicit keys. */
  windowEndsAt: number | null;
  status: OperationStatus;
  attempt: number;
  requestId: string;
  approvalId: string | null;
  result: CallToolResult | null;
}

export interface OperationKey {
  key: string;
  explicit: boolean;
  /** The arguments with idempotency_key removed: what gets forwarded. */
  args: Record<string, unknown>;
}

/** JSON with object keys sorted, so equal arguments always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The logical operation a call belongs to. Read tools have none. With an
 * explicit idempotency_key the agent decides what counts as "the same"; without
 * one, identical tool + arguments within the window are the same operation.
 */
export function operationKey(tool: string, rawArgs: Record<string, unknown>): OperationKey | null {
  const { [IDEMPOTENCY_ARG]: explicitKey, ...args } = rawArgs;
  if (classifyTool(tool) === "read") return null;
  if (typeof explicitKey === "string" && explicitKey.trim()) {
    return { key: `${tool}:key:${sha256(explicitKey.trim())}`, explicit: true, args };
  }
  return { key: `${tool}:args:${sha256(canonicalJson(args))}`, explicit: false, args };
}

/**
 * Deterministic from the key and attempt, so it survives restarts: a retry of an
 * operation whose outcome is unknown reuses it and PayPal returns the original
 * result. A new attempt (after a definite failure) gets a new one, because PayPal
 * would otherwise replay the cached failure.
 */
export function requestIdFor(key: string, attempt: number): string {
  return `handrail-${sha256(`${key}#${attempt}`).slice(0, 40)}`;
}

/**
 * Sorts a PayPal result into succeeded / failed / unknown. Only a 4xx answer is
 * a definite failure; no answer or a 5xx means the action may have happened.
 */
export function classifyOutcome(result: CallToolResult, threw: boolean): Outcome {
  if (threw) return "unknown";
  const first = result.content?.[0];
  if (first?.type === "text") {
    try {
      const body = JSON.parse(first.text) as { ok?: unknown; status?: unknown; code?: unknown };
      if (body && typeof body === "object" && body.ok === false) {
        // The toolkit failed while building the request, before sending it.
        if (body.code === "PAYPAL_API_SETUP_ERROR") return "failed";
        const status = typeof body.status === "number" ? body.status : null;
        return status !== null && status >= 400 && status < 500 ? "failed" : "unknown";
      }
    } catch {
      // Not JSON: fall through.
    }
  }
  return result.isError ? "failed" : "succeeded";
}

interface OperationRow {
  key: string;
  tool: string;
  explicit: number;
  created_at: number;
  window_ends_at: number | null;
  status: OperationStatus;
  attempt: number;
  request_id: string;
  approval_id: string | null;
  result_json: string | null;
}

export class OperationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly windowMs: number,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        key            TEXT    PRIMARY KEY,
        tool           TEXT    NOT NULL,
        explicit       INTEGER NOT NULL,
        created_at     INTEGER NOT NULL,
        window_ends_at INTEGER,
        status         TEXT    NOT NULL,
        attempt        INTEGER NOT NULL,
        request_id     TEXT    NOT NULL,
        approval_id    TEXT,
        result_json    TEXT,
        updated_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operations_approval ON operations (approval_id);
    `);
  }

  /** The live operation for a key, or null if there is none or its window has passed. */
  get(key: string, now: number): Operation | null {
    const row = this.db.prepare(`SELECT * FROM operations WHERE key = ?`).get(key) as OperationRow | undefined;
    if (!row) return null;
    if (row.window_ends_at !== null && now > row.window_ends_at) return null;
    return fromRow(row);
  }

  byApproval(approvalId: string): Operation | null {
    const row = this.db.prepare(`SELECT * FROM operations WHERE approval_id = ?`).get(approvalId) as OperationRow | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * Starts an attempt. A key with no live operation starts at attempt 1; after a
   * definite failure or abandonment the attempt (and request id) advances; an
   * unknown outcome keeps its request id so PayPal can de-duplicate the retry.
   */
  begin(
    op: OperationKey,
    tool: string,
    status: "in_flight" | "pending_approval",
    approvalId: string | null,
    now: number,
  ): Operation {
    const existing = this.get(op.key, now);
    const attempt = !existing ? 1 : existing.status === "unknown" ? existing.attempt : existing.attempt + 1;
    const fresh = !existing;
    this.db
      .prepare(
        `INSERT INTO operations (key, tool, explicit, created_at, window_ends_at, status, attempt, request_id, approval_id, result_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (key) DO UPDATE SET
           created_at = CASE WHEN ? THEN excluded.created_at ELSE created_at END,
           window_ends_at = CASE WHEN ? THEN excluded.window_ends_at ELSE window_ends_at END,
           status = excluded.status, attempt = excluded.attempt, request_id = excluded.request_id,
           approval_id = excluded.approval_id, result_json = NULL, updated_at = excluded.updated_at`,
      )
      .run(
        op.key,
        tool,
        op.explicit ? 1 : 0,
        now,
        op.explicit ? null : now + this.windowMs,
        status,
        attempt,
        requestIdFor(op.key, attempt),
        approvalId,
        now,
        fresh ? 1 : 0,
        fresh ? 1 : 0,
      );
    return this.get(op.key, now)!;
  }

  /** Marks every in-flight operation unknown (used at startup, after a crash). Returns how many. */
  interruptInFlight(now: number): number {
    return Number(
      this.db.prepare(`UPDATE operations SET status = 'unknown', updated_at = ? WHERE status = 'in_flight'`).run(now).changes,
    );
  }

  setStatus(key: string, status: OperationStatus, now: number, result?: CallToolResult): void {
    this.db
      .prepare(`UPDATE operations SET status = ?, result_json = COALESCE(?, result_json), updated_at = ? WHERE key = ?`)
      .run(status, result ? JSON.stringify(result) : null, now, key);
  }
}

function fromRow(row: OperationRow): Operation {
  return {
    key: row.key,
    tool: row.tool,
    explicit: row.explicit === 1,
    createdAt: row.created_at,
    windowEndsAt: row.window_ends_at,
    status: row.status,
    attempt: row.attempt,
    requestId: row.request_id,
    approvalId: row.approval_id,
    result: row.result_json ? (JSON.parse(row.result_json) as CallToolResult) : null,
  };
}
