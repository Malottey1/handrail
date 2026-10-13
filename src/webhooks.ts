import type { DatabaseSync } from "node:sqlite";
import { AuditChain, sha256 } from "./audit-chain.js";
import type { CallOutcome, CallRow } from "./audit.js";
import { formatMoney, toHundredths, type Money } from "./policy/money.js";

export interface WebhookEvent {
  id: string;
  event_type: string;
  summary?: string;
  resource?: Record<string, any>;
}

/** A forwarded agent call, parsed for matching. */
export interface ForwardedCall {
  id: number;
  tool: string;
  createdAt: string;
  args: Record<string, any>;
  /** PayPal's JSON response, if the result was JSON. */
  response: Record<string, any> | null;
  amount: Money | null;
  outcome: CallOutcome | null;
}

/**
 * matched          the agent call that caused this event, with consistent details
 * mismatch         the agent call was found, but PayPal's details disagree with it
 * outside_handrail "Unattributed – not sent through Handrail": a money-out action (refund, dispute conceded,
 *                  invoice or subscription cancelled) that PayPal reports but no agent call through Handrail made.
 *                  Something may have bypassed Handrail (an agent with its own PayPal credentials or a direct
 *                  toolkit connection). Flagged in the dashboard and alerted like a held call.
 * unrelated        no agent call, but this event is normal without one (e.g. a buyer paying)
 * ignored          an event type Handrail doesn't track
 */
export type MatchStatus = "matched" | "mismatch" | "outside_handrail" | "unrelated" | "ignored";

export interface MatchResult {
  status: MatchStatus;
  tool: string | null;
  callId: number | null;
  resourceId: string | null;
  reasons: string[];
}

interface EventRule {
  tool: string;
  /** The PayPal object this event is about. */
  resourceId(resource: Record<string, any>): string | null;
  /** Whether this agent call caused the event. */
  matches(resource: Record<string, any>, call: ForwardedCall): boolean;
  /** The amount PayPal reports, compared with the amount the agent call moved. */
  amount?(resource: Record<string, any>): Money | null;
  /** What it means when no agent call matches. */
  whenUnmatched: "outside_handrail" | "unrelated" | ((resource: Record<string, any>) => "outside_handrail" | "unrelated");
  /** Why an unattributed event matters, for the flag. Default: "no agent call through Handrail made it". */
  unattributedReason?: (resource: Record<string, any>, id: string) => string;
}

const lastSegment = (href: unknown) => (typeof href === "string" ? href.split("/").pop() ?? null : null);
const linkTo = (resource: Record<string, any>, rel: string) =>
  lastSegment((resource.links as Array<{ rel?: string; href?: string }> | undefined)?.find((l) => l.rel === rel)?.href);

function money(amount: { currency_code?: string; value?: string } | undefined): Money | null {
  if (!amount?.currency_code || typeof amount.value !== "string") return null;
  const hundredths = toHundredths(amount.value);
  return hundredths === null ? null : { hundredths, currency: amount.currency_code };
}

const invoiceId = (r: Record<string, any>) => (r.invoice?.id ?? r.id ?? null) as string | null;

/** Which agent tool each tracked event type corresponds to, and how to recognise its call. */
export const EVENT_RULES: Record<string, EventRule> = {
  "PAYMENT.CAPTURE.REFUNDED": {
    tool: "create_refund",
    resourceId: (r) => r.id ?? null,
    // The refund id from PayPal's response, or the capture the refund points "up" to.
    matches: (r, call) => call.response?.id === r.id || (!!linkTo(r, "up") && call.args.capture_id === linkTo(r, "up")),
    amount: (r) => money(r.amount),
    whenUnmatched: "outside_handrail",
  },
  "PAYMENT.CAPTURE.COMPLETED": {
    tool: "pay_order",
    resourceId: (r) => r.id ?? null,
    matches: (r, call) => {
      const orderId = r.supplementary_data?.related_ids?.order_id;
      const captures = call.response?.response?.purchase_units?.flatMap((u: any) => u.payments?.captures ?? []) ?? [];
      return (!!orderId && call.args.id === orderId) || captures.some((c: any) => c.id === r.id);
    },
    amount: (r) => money(r.amount),
    whenUnmatched: "unrelated",
  },
  "CUSTOMER.DISPUTE.RESOLVED": {
    tool: "accept_dispute_claim",
    resourceId: (r) => r.dispute_id ?? null,
    matches: (r, call) => call.args.dispute_id === r.dispute_id,
    // Resolved in the buyer's favour means money went back; a seller win doesn't need an agent call.
    whenUnmatched: (r) => (r.dispute_outcome?.outcome_code === "RESOLVED_BUYER_FAVOUR" ? "outside_handrail" : "unrelated"),
    unattributedReason: (_r, id) =>
      `Dispute ${id} was resolved in the buyer's favour, and no agent call through Handrail accepted it. ` +
      "Someone may have accepted the claim directly, or PayPal decided it.",
  },
  "CUSTOMER.DISPUTE.UPDATED": {
    tool: "accept_dispute_claim",
    resourceId: (r) => r.dispute_id ?? null,
    matches: (r, call) => call.args.dispute_id === r.dispute_id,
    whenUnmatched: "unrelated",
  },
  "INVOICING.INVOICE.CANCELLED": {
    tool: "cancel_sent_invoice",
    resourceId: invoiceId,
    matches: (r, call) => call.args.invoice_id === invoiceId(r),
    whenUnmatched: "outside_handrail",
  },
  "INVOICING.INVOICE.PAID": {
    tool: "send_invoice",
    resourceId: invoiceId,
    matches: (r, call) => call.args.invoice_id === invoiceId(r),
    whenUnmatched: "unrelated",
  },
  "BILLING.SUBSCRIPTION.CANCELLED": {
    tool: "cancel_subscription",
    resourceId: (r) => r.id ?? null,
    matches: (r, call) => call.args.subscription_id === r.id,
    whenUnmatched: "outside_handrail",
    unattributedReason: (_r, id) =>
      `Subscription ${id} was cancelled, and no agent call through Handrail cancelled it. The subscriber may have cancelled it themselves, or something bypassed Handrail.`,
  },
};

/**
 * Matches a PayPal event to the agent call that caused it. Pure: `calls` are
 * the forwarded calls of the event's tool, newest first.
 */
export function matchEvent(event: WebhookEvent, calls: ForwardedCall[]): MatchResult {
  const rule = EVENT_RULES[event.event_type];
  const resource = event.resource ?? {};
  if (!rule) return { status: "ignored", tool: null, callId: null, resourceId: null, reasons: [] };

  const resourceId = rule.resourceId(resource);
  const call = calls.find((c) => c.tool === rule.tool && rule.matches(resource, c));
  if (!call) {
    const status = typeof rule.whenUnmatched === "function" ? rule.whenUnmatched(resource) : rule.whenUnmatched;
    const reasons =
      status === "outside_handrail"
        ? [
            rule.unattributedReason?.(resource, resourceId ?? "(unknown id)") ??
              `PayPal reports a ${event.event_type} (${resourceId ?? "unknown id"}) that no agent call through Handrail made`,
          ]
        : [];
    return { status, tool: rule.tool, callId: null, resourceId, reasons };
  }

  const reasons: string[] = [];
  const reported = rule.amount?.(resource) ?? null;
  if (reported && call.amount && (reported.currency !== call.amount.currency || reported.hundredths !== call.amount.hundredths)) {
    reasons.push(`PayPal reports ${formatMoney(reported)}, but the agent call was for ${formatMoney(call.amount)}`);
  }
  if (call.outcome !== "succeeded") {
    reasons.push(`PayPal reports this happened, but Handrail recorded the call's outcome as ${call.outcome ?? "unknown"}`);
  }
  return { status: reasons.length ? "mismatch" : "matched", tool: rule.tool, callId: call.id, resourceId, reasons };
}

export function parseForwardedCall(row: CallRow): ForwardedCall {
  let response: Record<string, any> | null = null;
  try {
    const result = JSON.parse(row.result_json ?? "null");
    const text = result?.content?.[0]?.text;
    if (typeof text === "string") response = JSON.parse(text);
  } catch {
    // Non-JSON result: nothing to match on beyond the arguments.
  }
  return {
    id: row.id,
    tool: row.tool,
    createdAt: row.created_at,
    args: JSON.parse(row.args_json),
    response,
    amount: row.amount_hundredths !== null && row.currency ? { hundredths: row.amount_hundredths, currency: row.currency } : null,
    outcome: row.outcome,
  };
}

export interface UnattributedEvent {
  eventId: string;
  receivedAt: string;
  eventType: string;
  tool: string | null;
  resourceId: string | null;
  amount: Money | null;
  verified: boolean;
  reasons: string[];
}

export interface StoredEvent {
  event_id: string;
  received_at: string;
  event_type: string;
  summary: string | null;
  resource_id: string | null;
  verified: number;
  status: MatchStatus;
  tool: string | null;
  call_id: number | null;
  reasons_json: string;
}

export class WebhookStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly chain = new AuditChain(db),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id     TEXT    PRIMARY KEY,
        received_at  TEXT    NOT NULL,
        event_type   TEXT    NOT NULL,
        summary      TEXT,
        resource_id  TEXT,
        verified     INTEGER NOT NULL,
        status       TEXT    NOT NULL,
        tool         TEXT,
        call_id      INTEGER,
        reasons_json TEXT    NOT NULL,
        raw_json     TEXT    NOT NULL
      );
    `);
  }

  has(eventId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM webhook_events WHERE event_id = ?`).get(eventId) !== undefined;
  }

  /**
   * Stores an event once; PayPal redelivers events, and repeats are ignored.
   * The audit entry carries a hash of the raw body, so edits to it are detectable.
   */
  insert(event: WebhookEvent, verified: boolean, match: MatchResult, raw: string, now: number): boolean {
    return this.chain.record(now, () => {
      const inserted =
        this.db
          .prepare(
            `INSERT OR IGNORE INTO webhook_events
               (event_id, received_at, event_type, summary, resource_id, verified, status, tool, call_id, reasons_json, raw_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.id,
            new Date(now).toISOString(),
            event.event_type,
            event.summary ?? null,
            match.resourceId,
            verified ? 1 : 0,
            match.status,
            match.tool,
            match.callId,
            JSON.stringify(match.reasons),
            raw,
          ).changes === 1;
      const data = {
        eventType: event.event_type,
        resourceId: match.resourceId,
        verified,
        status: match.status,
        callId: match.callId,
        reasons: match.reasons,
        rawSha256: sha256(raw),
      };
      return { value: inserted, entries: inserted ? [{ kind: "webhook.received" as const, ref: `webhook:${event.id}`, data }] : [] };
    });
  }

  /**
   * Money-out actions PayPal reported that no agent call through Handrail
   * made ("Unattributed – not sent through Handrail"), newest first.
   */
  unattributed(limit = 200): UnattributedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, received_at, event_type, resource_id, verified, tool, reasons_json, raw_json FROM webhook_events
         WHERE status = 'outside_handrail' ORDER BY received_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ event_id: string; received_at: string; event_type: string; resource_id: string | null; verified: number; tool: string | null; reasons_json: string; raw_json: string }>;
    return rows.map((r) => {
      let amount: Money | null = null;
      try {
        amount = EVENT_RULES[r.event_type]?.amount?.((JSON.parse(r.raw_json) as WebhookEvent).resource ?? {}) ?? null;
      } catch {
        // Stored raw body that isn't JSON: no amount.
      }
      return {
        eventId: r.event_id,
        receivedAt: r.received_at,
        eventType: r.event_type,
        tool: r.tool,
        resourceId: r.resource_id,
        amount,
        verified: r.verified === 1,
        reasons: JSON.parse(r.reasons_json) as string[],
      };
    });
  }

  list(status?: MatchStatus, limit = 100): StoredEvent[] {
    const cols = "event_id, received_at, event_type, summary, resource_id, verified, status, tool, call_id, reasons_json";
    const rows = status
      ? this.db.prepare(`SELECT ${cols} FROM webhook_events WHERE status = ? ORDER BY received_at DESC LIMIT ?`).all(status, limit)
      : this.db.prepare(`SELECT ${cols} FROM webhook_events ORDER BY received_at DESC LIMIT ?`).all(limit);
    return rows as unknown as StoredEvent[];
  }
}
