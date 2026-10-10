// Typed client for Handrail's admin API (src/admin-api.ts).

export interface Session {
  token: string;
  name: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(session: Session, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (e.g. the proxy couldn't reach Handrail).
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export interface Money {
  hundredths: number;
  currency: string;
}

export type Decision = "allow" | "require_approval" | "block";

export interface RuleHit {
  ruleId: string;
  decision: Decision;
  reason: string;
}

export type ApprovalStatus = "pending" | "executing" | "executed" | "failed" | "blocked" | "rejected" | "expired";

export interface Approval {
  id: string;
  status: ApprovalStatus;
  tool: string;
  args: Record<string, unknown>;
  amount: Money | null;
  amountSource: string;
  payee: string | null;
  decision: Decision;
  reason: string;
  rules: RuleHit[];
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  result: unknown;
}

export interface CallRow {
  id: number;
  created_at: string;
  tool: string;
  args_json: string;
  decision: Decision | "duplicate";
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
  outcome: string | null;
}

export type MatchStatus = "matched" | "mismatch" | "outside_handrail" | "unrelated" | "ignored";

export interface WebhookRow {
  event_id: string;
  received_at: string;
  event_type: string;
  summary: string | null;
  resource_id: string | null;
  verified: number;
  status: MatchStatus;
  tool: string | null;
  call_id: number | null;
  reasons: string[];
}

export interface AuditEntry {
  seq: number;
  at: string;
  kind: string;
  ref: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  head: string;
  problems: Array<{ seq: number | null; ref: string | null; problem: string }>;
}

export interface Summary {
  pendingApprovals: number;
  last24h: { calls: number; forwarded: number; held: number; blocked: number; duplicates: number; failed: number };
  webhooks: { total: number; flagged: number };
}

export type Rule = {
  id: string;
  description?: string;
  tools: string[];
  decision: Decision;
} & (
  | { type: "tool" }
  | { type: "amount_ceiling"; max: string; currency: string }
  | { type: "rate_limit"; max: number; windowSeconds: number }
  | { type: "spend_limit"; max: string; currency: string; windowSeconds: number }
  | { type: "payee_allowlist"; allow: string[] }
);

export interface Policy {
  version: 1;
  defaults: Record<"read" | "write" | "money" | "unknown", Decision>;
  rules: Rule[];
}
