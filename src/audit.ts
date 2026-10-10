import { DatabaseSync } from "node:sqlite";

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

/**
 * Step 1 call log: one row per forwarded tool call. The hash-chained audit log
 * from the design replaces this in a later step.
 */
export class CallLog {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  TEXT    NOT NULL,
        tool        TEXT    NOT NULL,
        args_json   TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        is_error    INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      )
    `);
  }

  record(call: ToolCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (created_at, tool, args_json, result_json, is_error, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        call.tool,
        JSON.stringify(call.args ?? {}),
        JSON.stringify(call.result ?? null),
        call.isError ? 1 : 0,
        Math.round(call.durationMs),
      );
  }
}
