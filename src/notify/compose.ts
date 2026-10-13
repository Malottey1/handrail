import type { Approval } from "../approvals.js";
import { toolLabel } from "../policy/describe.js";
import { formatMoney } from "../policy/money.js";

/**
 * The alert for a held call, in every format it's sent in. It says what the
 * agent wants, the rule that held it, the AI's one-line summary and where to
 * review it. It never carries a way to approve: the link opens the dashboard,
 * which needs a signed-in approver. No tokens, keys or agent-written text
 * (notes, reasons) go in it; identifiers are reduced to safe characters.
 */
export interface HeldAlert {
  approvalId: string;
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
  const email = safeEmail(approval.facts.payee);
  if (email) return email;
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
  const text = [`A call was held for your approval.`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `Review it: ${link}`, signIn].join("\n");
  const html = [
    `<p>A call was held for your approval.</p>`,
    `<table cellpadding="4" style="border-collapse:collapse">`,
    ...rows.map(([k, v]) => `<tr><td style="color:#56605a;vertical-align:top">${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`),
    `</table>`,
    `<p><a href="${escapeHtml(link)}" style="background:#127842;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Review in Handrail</a></p>`,
    `<p style="color:#56605a;font-size:13px">${escapeHtml(signIn)}</p>`,
  ].join("\n");
  const slackLines = rows.map(([k, v]) => `*${escapeSlack(k)}:* ${escapeSlack(v)}`).join("\n");
  const slack = {
    text: subject,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(subject)}*\n${slackLines}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `<${link}|Review in Handrail> (sign-in required). ${escapeSlack(signIn.split(". ")[1] ?? "")}` }] },
    ],
  };
  return { approvalId: approval.id, subject, text, html, slack, link };
}
