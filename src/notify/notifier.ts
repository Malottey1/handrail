import type { DatabaseSync } from "node:sqlite";
import type { Approval } from "../approvals.js";
import { AuditChain } from "../audit-chain.js";
import { log } from "../log.js";
import { redact } from "../redact.js";
import type { EmailSender, SlackPoster } from "./channels.js";
import { composeHeldAlert, type HeldAlert } from "./compose.js";

/**
 * sent     every channel that was on delivered it
 * partial  some deliveries failed
 * failed   every delivery failed
 * off      alerts aren't set up (no email provider, no Slack webhook): nothing was sent
 * nobody   email is on but no approver or admin wants email alerts, and Slack is off
 * skipped  the call was decided or expired before the alert went out
 * preview  demo workspace: shown in the dashboard, never sent
 */
export type AlertStatus = "sent" | "partial" | "failed" | "off" | "nobody" | "skipped" | "preview";

export interface AlertRecord {
  approvalId: string;
  at: number;
  status: AlertStatus;
  /** Names of the people emailed (never their addresses), and what happened per channel. */
  email: { to: string[]; failed: number } | null;
  slack: "sent" | "failed" | null;
  /** The message itself, for demo previews. */
  preview: { subject: string; text: string } | null;
}

/** One row per held call's alert, in the workspace's database. Each is also an audit entry. */
export class AlertStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly chain = new AuditChain(db),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        approval_id  TEXT    PRIMARY KEY,
        at           INTEGER NOT NULL,
        status       TEXT    NOT NULL,
        email_json   TEXT,
        slack        TEXT,
        preview_json TEXT
      );
    `);
  }

  record(alert: AlertRecord): void {
    this.chain.record(alert.at, () => {
      this.db
        .prepare(`INSERT OR REPLACE INTO alerts (approval_id, at, status, email_json, slack, preview_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          alert.approvalId,
          alert.at,
          alert.status,
          alert.email ? JSON.stringify(alert.email) : null,
          alert.slack,
          alert.preview ? JSON.stringify(alert.preview) : null,
        );
      const data = { approvalId: alert.approvalId, status: alert.status, email: alert.email, slack: alert.slack };
      return { value: undefined, entries: [{ kind: "alert.sent" as const, ref: `alert:${alert.approvalId}`, data }] };
    });
  }

  get(approvalId: string): AlertRecord | null {
    const row = this.db.prepare(`SELECT * FROM alerts WHERE approval_id = ?`).get(approvalId) as
      | { approval_id: string; at: number; status: AlertStatus; email_json: string | null; slack: "sent" | "failed" | null; preview_json: string | null }
      | undefined;
    if (!row) return null;
    return {
      approvalId: row.approval_id,
      at: row.at,
      status: row.status,
      email: row.email_json ? JSON.parse(row.email_json) : null,
      slack: row.slack,
      preview: row.preview_json ? JSON.parse(row.preview_json) : null,
    };
  }
}

export interface AlertChannels {
  /** "live" sends; "preview" (demo workspaces) only records what would be sent. */
  mode: "live" | "preview";
  email: boolean;
  slack: boolean;
}

export interface Recipient {
  id: string;
  name: string;
  email: string;
}

export interface HeldNotifier {
  channels(): AlertChannels;
  held(approval: Approval): Promise<void>;
}

export interface LiveNotifierDeps {
  /** Null when no email provider is configured. */
  email: EmailSender | null;
  slackWebhook: () => string | null;
  postSlack: SlackPoster;
  /** Approvers and admins who want email alerts. */
  recipients: () => Recipient[];
  baseUrl: string;
  alerts: AlertStore;
  now?: () => number;
}

/** Sends held-call alerts by email and Slack. Failures are logged and recorded, never thrown. */
export class LiveNotifier implements HeldNotifier {
  constructor(private readonly deps: LiveNotifierDeps) {}

  channels(): AlertChannels {
    return { mode: "live", email: this.deps.email !== null, slack: this.deps.slackWebhook() !== null };
  }

  async held(approval: Approval): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const base = { approvalId: approval.id, preview: null };
    const { email: emailOn, slack: slackOn } = this.channels();
    if (!emailOn && !slackOn) {
      this.deps.alerts.record({ ...base, at: now(), status: "off", email: null, slack: null });
      return;
    }
    if (approval.status !== "pending") {
      this.deps.alerts.record({ ...base, at: now(), status: "skipped", email: null, slack: null });
      return;
    }

    const alert = composeHeldAlert(approval, this.deps.baseUrl);
    let delivered = 0;
    let failures = 0;

    let email: AlertRecord["email"] = null;
    if (this.deps.email) {
      const to = this.deps.recipients();
      email = { to: to.map((r) => r.name), failed: 0 };
      for (const r of to) {
        try {
          await this.deps.email.send({ to: { email: r.email, name: r.name }, subject: alert.subject, text: alert.text, html: alert.html });
          delivered++;
        } catch (err) {
          email.failed++;
          failures++;
          log(`Alert email for ${approval.id} to ${r.name} failed: ${(err as Error).message}`);
        }
      }
    }

    let slack: AlertRecord["slack"] = null;
    const webhook = this.deps.slackWebhook();
    if (webhook) {
      try {
        await this.deps.postSlack(webhook, alert.slack);
        slack = "sent";
        delivered++;
      } catch (err) {
        slack = "failed";
        failures++;
        log(`Alert to Slack for ${approval.id} failed: ${redact((err as Error).message)}`);
      }
    }

    const status: AlertStatus = failures === 0 ? (delivered === 0 ? "nobody" : "sent") : delivered === 0 ? "failed" : "partial";
    this.deps.alerts.record({ ...base, at: now(), status, email, slack });
    log(`Alert for ${approval.id}: ${status} (email to ${email?.to.length ?? 0}${slack ? `, Slack ${slack}` : ""})`);
  }
}

/** Demo workspaces: never send anything; keep the message to show in the dashboard. */
export class PreviewNotifier implements HeldNotifier {
  constructor(
    private readonly alerts: AlertStore,
    private readonly baseUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  channels(): AlertChannels {
    return { mode: "preview", email: false, slack: false };
  }

  async held(approval: Approval): Promise<void> {
    const alert: HeldAlert = composeHeldAlert(approval, this.baseUrl);
    this.alerts.record({
      approvalId: approval.id,
      at: this.now(),
      status: "preview",
      email: null,
      slack: null,
      preview: { subject: alert.subject, text: alert.text },
    });
  }
}
