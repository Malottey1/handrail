import type { DatabaseSync } from "node:sqlite";
import { AuditChain } from "../audit-chain.js";
import { registerSecrets } from "../redact.js";
import { maskSlackWebhook, slackWebhookProblem } from "./channels.js";

export class SettingsError extends Error {
  readonly status = 400;
}

/**
 * Server-side settings an admin changes from the dashboard. Today: the Slack
 * webhook for held-call alerts. The URL works as a credential, so it's never
 * returned in full, never written to the audit log (only "set"/"removed" and
 * who did it), and redacted from logs and errors like any other secret.
 */
export class SettingsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly chain = new AuditChain(db),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT    PRIMARY KEY,
        value      TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );
    `);
    registerSecrets(this.slackWebhook() ?? undefined);
  }

  slackWebhook(): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'slack_webhook'`).get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** What admins see: whether it's set, a masked form, when and by whom. */
  slackWebhookInfo(): { set: boolean; masked: string | null; updatedAt: number | null; updatedBy: string | null } {
    const row = this.db.prepare(`SELECT value, updated_at, updated_by FROM settings WHERE key = 'slack_webhook'`).get() as
      | { value: string; updated_at: number; updated_by: string | null }
      | undefined;
    return row
      ? { set: true, masked: maskSlackWebhook(row.value), updatedAt: row.updated_at, updatedBy: row.updated_by }
      : { set: false, masked: null, updatedAt: null, updatedBy: null };
  }

  /** Sets (or with null, removes) the Slack webhook. */
  setSlackWebhook(url: string | null, by: { id: string; name: string }, now: number): void {
    const value = url?.trim() || null;
    if (value) {
      const problem = slackWebhookProblem(value);
      if (problem) throw new SettingsError(problem);
      registerSecrets(value);
    }
    this.chain.record(now, () => {
      if (value) {
        this.db
          .prepare(
            `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('slack_webhook', ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          )
          .run(value, now, by.name);
      } else {
        this.db.prepare(`DELETE FROM settings WHERE key = 'slack_webhook'`).run();
      }
      const data = { setting: "slack_webhook", change: value ? "set" : "removed", masked: value ? maskSlackWebhook(value) : null, by };
      return { value: undefined, entries: [{ kind: "settings.changed" as const, ref: "settings:slack_webhook", data }] };
    });
  }
}
