import type { Approval } from "../approvals.js";
import { toolLabel } from "../policy/describe.js";
import { formatMoney, type Money } from "../policy/money.js";

/**
 * The alert for a held call, in every format it's sent in. It says what the
 * agent wants, the rule that held it, the AI's one-line summary and where to
 * review it. It never carries a way to approve: the link opens the dashboard,
 * which needs a signed-in approver. No tokens, keys or agent-written text
 * (notes, reasons) go in it; identifiers are reduced to safe characters.
 */
export interface ComposedAlert {
  subject: string;
  /** Plain text: the email's text part, and the in-app demo preview. */
  text: string;
  html: string;
  slack: { text: string; blocks: unknown[] };
  link: string;
}

const ID_ARGS: Array<[string, string]> = [
  ["capture_id", "capture"],
  ["order_id", "order"],
  ["dispute_id", "dispute"],
  ["invoice_id", "invoice"],
  ["subscription_id", "subscription"],
  ["id", "id"],
];

/** PayPal ids are short and alphanumeric; anything else is shown as "(not shown)". */
const safeId = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9-]{1,40}$/.test(v) ? v : null);
const safeEmail = (v: string | null) => (v && /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,190}$/.test(v) ? v : null);

/** Who or what the call is about: the payer/recipient if known, else the PayPal object it targets. */
export function customerOf(approval: Approval): string {
  const payer = approval.facts.verified?.payer;
  const email = safeEmail(approval.facts.payee) ?? safeEmail(payer?.email ?? null);
  if (email) return email;
  const name = payer?.name?.replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 80).trim();
  const card = payer?.card?.replace(/[^\w ]/g, "").slice(0, 40);
  if (name || card) return [name, card && `(${card})`].filter(Boolean).join(" ");
  for (const [key, label] of ID_ARGS) {
    if (key in approval.args) {
      const id = safeId(approval.args[key]);
      return id ? `${label} ${id}` : `${label} (not shown)`;
    }
  }
  return "not stated";
}

/**
 * The first sentence of the AI summary, at most 200 characters. Links are
 * removed: the model read agent-written text, and an alert must not carry a
 * link anywhere but the dashboard.
 */
export function oneLine(summary: string): string {
  const clean = summary.replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]").replace(/\s+/g, " ").trim();
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type HeldAlert = ComposedAlert;

export function composeHeldAlert(approval: Approval, baseUrl: string): HeldAlert {
  const what = `${toolLabel(approval.tool)}${approval.facts.amount ? ` of ${formatMoney(approval.facts.amount)}` : ""}`;
  const hold = approval.evaluation.hits.find((h) => h.decision === "require_approval") ?? approval.evaluation.hits[0];
  const rule = hold ? `${hold.ruleId}: ${hold.reason}` : approval.evaluation.reason;
  const ai =
    approval.explanationStatus === "ready" && approval.explanation
      ? oneLine(approval.explanation.summary)
      : approval.explanationStatus === "pending"
        ? "Still being written; it will be on the approval card."
        : null;
  const link = `${baseUrl.replace(/\/$/, "")}/app#approvals/${encodeURIComponent(approval.id)}`;
  const expires = new Date(approval.expiresAt).toUTCString();

  const rows: Array<[string, string]> = [
    ["The agent wants to", what],
    ["Customer", customerOf(approval)],
    ["Agent", approval.agent?.name ?? "Unknown agent"],
    ["Held by", rule],
    ...(ai ? ([["AI summary", ai]] as Array<[string, string]>) : []),
    ["Expires", `${expires} (not sent to PayPal unless someone approves it first)`],
  ];
  const signIn = "Sign in to Handrail to approve or reject it. Nothing can be approved from this message.";

  const subject = `Approval needed: ${what}`;
  return render({ subject, intro: "A call was held for your approval.", rows, link, linkLabel: "Review in Handrail", footer: signIn });
}

/** A money-out action PayPal reported that no agent call through Handrail made. */
export interface UnattributedInfo {
  eventId: string;
  eventType: string;
  /** The tool it corresponds to, e.g. create_refund. */
  tool: string | null;
  resourceId: string | null;
  amount: Money | null;
  reason: string;
  at: number;
}

const EVENT_WORDS: Record<string, string> = {
  "PAYMENT.CAPTURE.REFUNDED": "A refund",
  "CUSTOMER.DISPUTE.RESOLVED": "A dispute resolved in the buyer's favour",
  "INVOICING.INVOICE.CANCELLED": "An invoice cancellation",
  "BILLING.SUBSCRIPTION.CANCELLED": "A subscription cancellation",
};

export function composeUnattributedAlert(info: UnattributedInfo, baseUrl: string): ComposedAlert {
  const what = `${EVENT_WORDS[info.eventType] ?? info.eventType}${info.amount ? ` of ${formatMoney(info.amount)}` : ""}`;
  const id = safeId(info.resourceId);
  const rows: Array<[string, string]> = [
    ["PayPal reports", what],
    ["PayPal id", id ?? "(not shown)"],
    ["Sent through Handrail", "No. No agent call through Handrail made this."],
    ["Why it matters", info.reason],
    ["Reported", new Date(info.at).toUTCString()],
  ];
  return render({
    subject: `Not sent through Handrail: ${what}`,
    intro: "PayPal reported a money-out action that didn't go through Handrail. Something may be bypassing it.",
    rows,
    link: `${baseUrl.replace(/\/$/, "")}/app#activity`,
    linkLabel: "See it in Handrail",
    footer: "Check that no agent has its own PayPal credentials or a direct PayPal connection (Setup tab).",
  });
}

function render(a: { subject: string; intro: string; rows: Array<[string, string]>; link: string; linkLabel: string; footer: string }): ComposedAlert {
  const text = [a.intro, "", ...a.rows.map(([k, v]) => `${k}: ${v}`), "", `${a.linkLabel}: ${a.link}`, a.footer].join("\n");
  const html = [
    `<p>${escapeHtml(a.intro)}</p>`,
    `<table cellpadding="4" style="border-collapse:collapse">`,
    ...a.rows.map(([k, v]) => `<tr><td style="color:#56605a;vertical-align:top">${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`),
    `</table>`,
    `<p><a href="${escapeHtml(a.link)}" style="background:#127842;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(a.linkLabel)}</a></p>`,
    `<p style="color:#56605a;font-size:13px">${escapeHtml(a.footer)}</p>`,
  ].join("\n");
  const slack = {
    text: a.subject,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(a.subject)}*\n${a.rows.map(([k, v]) => `*${escapeSlack(k)}:* ${escapeSlack(v)}`).join("\n")}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `<${a.link}|${escapeSlack(a.linkLabel)}> (sign-in required). ${escapeSlack(a.footer)}` }] },
    ],
  };
  return { subject: a.subject, text, html, slack, link: a.link };
}
