import type { CallRow, Money } from "./api";

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

export function formatMoney(m: Money | null | undefined): string {
  if (!m) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency }).format(m.hundredths / 100);
  } catch {
    return `${(m.hundredths / 100).toFixed(2)} ${m.currency}`;
  }
}

export function callAmount(row: CallRow): Money | null {
  return row.amount_hundredths !== null && row.currency ? { hundredths: row.amount_hundredths, currency: row.currency } : null;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function countdown(iso: string, now = Date.now()): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return "expired";
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}:${String(s % 60).padStart(2, "0")} left`;
}

export function duration(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? "a day" : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "an hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export function parseJson<T = unknown>(json: string | null | undefined): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** PayPal's answer inside an MCP result, parsed if it's JSON. */
export function paypalResponse(result: unknown): Record<string, any> | null {
  const text = (result as { content?: Array<{ text?: string }> } | null)?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  return parseJson<Record<string, any>>(text);
}

const HANDRAIL_STATUS: Record<string, string> = {
  pending_approval: "Not sent yet: waiting for approval",
  blocked: "Not sent: blocked by policy",
  rejected: "Not sent: rejected by a human",
};

/** One line describing what PayPal said, e.g. "COMPLETED · 9JV16611T18836942". */
export function paypalSummary(result: unknown): string {
  const handrail = (result as { handrail?: { status?: string; message?: string } } | null)?.handrail;
  if (handrail) return handrail.message ?? HANDRAIL_STATUS[handrail.status ?? ""] ?? handrail.status ?? "";
  const r = paypalResponse(result);
  if (!r) return "";
  if (r.ok === false) return `PayPal error ${r.status ?? ""}: ${r.message ?? r.code ?? ""}`.trim();
  const body = r.response ?? r;
  return [body.status, body.id].filter(Boolean).join(" · ");
}
