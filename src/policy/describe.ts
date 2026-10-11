// Plain-English descriptions of tools and rules. Shared by the server (AI
// prompts) and the dashboard, so both say the same thing. No Node imports.
import type { Rule } from "./types.js";

const TOOL_LABELS: Record<string, string> = {
  create_refund: "Refund",
  pay_order: "Capture payment",
  accept_dispute_claim: "Accept dispute",
  cancel_sent_invoice: "Cancel invoice",
  cancel_subscription: "Cancel subscription",
  cancel_recurring_series: "Cancel recurring series",
  send_invoice: "Send invoice",
  send_invoice_reminder: "Send invoice reminder",
  record_refund_for_invoice: "Record invoice refund",
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

export function duration(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? "a day" : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "an hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "a minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

const money = (max: string, currency: string) =>
  `${Number(max).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const tools = (list: string[]) => list.map(toolLabel).join(", ");

export const DECISION_WORDS = { allow: "Allowed", require_approval: "Needs approval", block: "Blocked" } as const;

/** The condition a rule checks, as a phrase: "Refund over 100.00 USD". */
export function describeRule(rule: Rule): string {
  switch (rule.type) {
    case "tool":
      return `${tools(rule.tools)}, every time`;
    case "amount_ceiling":
      return `${tools(rule.tools)} over ${money(rule.max, rule.currency)}`;
    case "rate_limit":
      return `More than ${rule.max} ${tools(rule.tools)} calls in ${duration(rule.windowSeconds)}`;
    case "spend_limit":
      return `${tools(rule.tools)} totalling more than ${money(rule.max, rule.currency)} in ${duration(rule.windowSeconds)}`;
    case "payee_allowlist":
      return `${tools(rule.tools)} to anyone other than ${rule.allow.join(", ")}`;
  }
}

/** "Refund over 100.00 USD → Needs approval" */
export function ruleSentence(rule: Rule): string {
  return `${describeRule(rule)} → ${DECISION_WORDS[rule.decision]}`;
}
