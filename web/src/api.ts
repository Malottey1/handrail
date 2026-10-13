// Typed client for Handrail's admin API (src/admin-api.ts).
import type { Policy, Rule } from "../../src/policy/types.js";

export type { Policy, Rule };

export type Role = "admin" | "approver" | "viewer";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  isDemo: boolean;
  createdAt: string;
  disabled: boolean;
  /** Gets an email when a call is held (approvers and admins). Always false for the demo account. */
  emailAlerts: boolean;
}

/** The signed-in user. The session itself is an httpOnly cookie; the CSRF token goes in a header on changes. */
export interface Session {
  user: User;
  csrfToken: string;
}

export interface AuthState {
  user: User | null;
  csrfToken: string | null;
  setupRequired: boolean;
  demoAccess: boolean;
}

const RANK: Record<Role, number> = { viewer: 0, approver: 1, admin: 2 };
/** For showing or hiding controls. The server enforces roles on every request regardless. */
export const can = (session: Session, role: Role) => RANK[session.user.role] >= RANK[role];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(session: Session | null, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(session && method !== "GET" ? { "X-CSRF-Token": session.csrfToken } : {}),
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
    if (res.status === 401 && session) window.dispatchEvent(new Event("handrail:signed-out"));
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

export interface AgentKey {
  id: string;
  name: string;
  prefix: string;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface AgentIdentity {
  keyId: string | null;
  name: string;
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
  decidedById: string | null;
  agent: AgentIdentity | null;
  note: string | null;
  result: unknown;
  explanation: Explanation | null;
  explanationStatus: "pending" | "ready" | "failed" | "unavailable" | null;
  explanationModel: string | null;
  /** The held-call alert for this approval, once it went out (or was previewed, in a demo). */
  alert: AlertInfo | null;
}

export type AlertStatus = "sent" | "partial" | "failed" | "off" | "nobody" | "skipped" | "preview";

export interface AlertInfo {
  status: AlertStatus;
  at: string;
  /** Names of the people emailed. */
  emailedTo: string[];
  emailFailed: number;
  slack: "sent" | "failed" | null;
  /** Demo workspaces: the message approvers would have got. */
  preview: { subject: string; text: string } | null;
}

export interface AlertChannels {
  mode: "live" | "preview";
  email: boolean;
  slack: boolean;
}

export interface AlertSettings {
  email: { configured: boolean; provider: string | null };
  slack: { set: boolean; masked: string | null; updatedAt: number | null; updatedBy: string | null };
  /** Names of the approvers and admins who get emails. */
  recipients: string[];
}

export interface Explanation {
  summary: string;
  whyHeld: string;
  context: string[];
  checkBeforeApproving: string[];
  concerns: string[];
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
  agent_key_id: string | null;
  agent_name: string | null;
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
  last24h: { calls: number; forwarded: number; held: number; expired: number; blocked: number; duplicates: number; failed: number };
  webhooks: { total: number; flagged: number };
  alerts: AlertChannels;
}

export interface PolicyResponse {
  policy: Policy;
  hash: string;
  ai: { enabled: boolean; model: string | null };
}

/** From POST /api/policy/compile. Nothing changes until it's sent back with PUT /api/policy. */
export interface PolicyProposal {
  question: string | null;
  add: Rule[];
  remove: string[];
  assumptions: string[];
  sentences: { add: string[]; remove: string[] };
  warnings: string[];
  policy: Policy;
  baseHash: string;
  model: string;
}

export type DemoStepStatus = "waiting" | "running" | "done" | "unexpected" | "failed";

export interface DemoStatus {
  run: {
    id: string;
    startedAt: number;
    finishedAt: number | null;
    status: "running" | "done" | "failed";
    error: string | null;
    plan: { limit: string; ruleId: string; small: string; large: string; sale: string };
    captureId: string | null;
    steps: Array<{ id: string; title: string; expect: string; status: DemoStepStatus; outcome: string | null }>;
  } | null;
  /** The held refund from the latest run, live. */
  approval: { id: string; status: ApprovalStatus; decidedBy: string | null } | null;
  nextRunInSeconds: number;
  resetsAfterMinutes: number;
}
