import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CompileError, compilePolicy } from "./ai/compile.js";
import type { Llm } from "./ai/llm.js";
import type { Approval, ApprovalStatus } from "./approvals.js";
import type { AuditChain } from "./audit-chain.js";
import type { CallLog } from "./audit.js";
import { DecisionError, type Gate } from "./gate.js";
import { PolicyConflictError, type PolicyStore } from "./policy/store.js";
import type { MatchStatus, WebhookStore } from "./webhooks.js";

export interface AdminDeps {
  gate: Gate;
  callLog: CallLog;
  webhooks: WebhookStore;
  audit: AuditChain;
  policy: PolicyStore;
  /** For compiling plain-English rules. Null when AI features are off. */
  llm: Llm | null;
  /** Bearer token required on every /api request. Unset disables the API. */
  adminToken: string | undefined;
}

const STATUSES = new Set<ApprovalStatus>(["pending", "executing", "executed", "failed", "blocked", "rejected", "expired"]);

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body, null, 2));
}

export function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function present(a: Approval) {
  return {
    id: a.id,
    status: a.status,
    tool: a.tool,
    args: a.args,
    amount: a.facts.amount,
    amountSource: a.facts.amountSource,
    payee: a.facts.payee,
    decision: a.evaluation.decision,
    reason: a.evaluation.reason,
    rules: a.evaluation.hits,
    createdAt: new Date(a.createdAt).toISOString(),
    expiresAt: new Date(a.expiresAt).toISOString(),
    decidedAt: a.decidedAt ? new Date(a.decidedAt).toISOString() : null,
    decidedBy: a.decidedBy,
    note: a.note,
    result: a.result,
    explanation: a.explanation,
    explanationStatus: a.explanationStatus,
    explanationModel: a.explanationModel,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function summary(deps: AdminDeps) {
  const counts = deps.callLog.counts(Date.now() - DAY_MS);
  const total = (match: (c: { decision: string; outcome: string | null }) => boolean) =>
    counts.filter(match).reduce((sum, c) => sum + c.n, 0);
  const webhooks = deps.webhooks.list(undefined, 1000);
  return {
    pendingApprovals: deps.gate.listApprovals("pending").length,
    last24h: {
      calls: total(() => true),
      forwarded: total((c) => c.decision !== "duplicate" && c.outcome !== "held" && c.outcome !== "blocked"),
      held: total((c) => c.outcome === "held"),
      blocked: total((c) => c.decision === "block" || c.outcome === "blocked"),
      duplicates: total((c) => c.decision === "duplicate"),
      failed: total((c) => c.outcome === "failed" || c.outcome === "unknown"),
    },
    webhooks: {
      total: webhooks.length,
      flagged: webhooks.filter((w) => w.status === "mismatch" || w.status === "outside_handrail").length,
    },
  };
}

/**
 * REST API for humans (and later the dashboard). Returns false if the request
 * isn't an /api route.
 *
 *   GET  /api/summary                      (counts for the last 24 hours)
 *   GET  /api/approvals?status=pending
 *   GET  /api/approvals/:id
 *   POST /api/approvals/:id/approve   { "by": "name", "note": "..." }
 *   POST /api/approvals/:id/reject    { "by": "name", "note": "..." }
 *   GET  /api/calls?limit=50
 *   GET  /api/webhooks?status=mismatch
 *   GET  /api/audit?limit=100&ref=call:12   (newest first)
 *   GET  /api/audit/verify
 *   GET  /api/policy                       { policy, hash, ai }
 *   POST /api/policy/compile               { instruction }  -> a proposal; changes nothing
 *   PUT  /api/policy                       { policy, baseHash, by, source }  -> the confirmed change
 */
export async function handleAdmin(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;

  if (!deps.adminToken) {
    send(res, 503, { error: "Admin API disabled: set HANDRAIL_ADMIN_TOKEN in .env" });
    return true;
  }
  if (!authorized(req, deps.adminToken)) {
    send(res, 401, { error: "Missing or wrong admin token" });
    return true;
  }

  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  try {
    if (req.method === "GET" && parts[1] === "summary" && parts.length === 2) {
      send(res, 200, summary(deps));
    } else if (req.method === "GET" && parts[1] === "approvals" && parts.length === 2) {
      const status = url.searchParams.get("status") as ApprovalStatus | null;
      if (status && !STATUSES.has(status)) send(res, 400, { error: `Unknown status ${status}` });
      else send(res, 200, deps.gate.listApprovals(status ?? undefined).map(present));
    } else if (req.method === "GET" && parts[1] === "approvals" && parts.length === 3) {
      const approval = deps.gate.getApproval(parts[2]!);
      approval ? send(res, 200, present(approval)) : send(res, 404, { error: "Not found" });
    } else if (req.method === "POST" && parts[1] === "approvals" && parts.length === 4 && ["approve", "reject"].includes(parts[3]!)) {
      const body = await readBody(req);
      const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 100) : "admin";
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
      const approval =
        parts[3] === "approve" ? await deps.gate.approve(parts[2]!, by, note) : deps.gate.reject(parts[2]!, by, note);
      send(res, 200, present(approval));
    } else if (req.method === "GET" && parts[1] === "calls" && parts.length === 2) {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
      send(res, 200, deps.callLog.recent(limit));
    } else if (req.method === "GET" && parts[1] === "webhooks" && parts.length === 2) {
      const status = (url.searchParams.get("status") as MatchStatus | null) ?? undefined;
      const events = deps.webhooks.list(status).map(({ reasons_json, ...e }) => ({ ...e, reasons: JSON.parse(reasons_json) }));
      send(res, 200, events);
    } else if (req.method === "GET" && parts[1] === "audit" && parts.length === 2) {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 1000);
      const rows = deps.audit.list(limit, url.searchParams.get("ref") ?? undefined);
      send(res, 200, rows.map(({ data_json, ...r }) => ({ ...r, data: JSON.parse(data_json) })));
    } else if (req.method === "GET" && parts[1] === "audit" && parts[2] === "verify" && parts.length === 3) {
      send(res, 200, deps.audit.verify());
    } else if (req.method === "GET" && parts[1] === "policy" && parts.length === 2) {
      send(res, 200, { policy: deps.policy.get(), hash: deps.policy.hash(), ai: { enabled: !!deps.llm, model: deps.llm?.model ?? null } });
    } else if (req.method === "POST" && parts[1] === "policy" && parts[2] === "compile" && parts.length === 3) {
      if (!deps.llm) {
        send(res, 503, { error: "AI features are off: set ANTHROPIC_API_KEY in .env" });
      } else {
        const body = await readBody(req);
        const baseHash = deps.policy.hash();
        const proposal = await compilePolicy(typeof body.instruction === "string" ? body.instruction : "", deps.policy.get(), deps.llm);
        send(res, 200, { ...proposal, baseHash, model: deps.llm.model });
      }
    } else if (req.method === "PUT" && parts[1] === "policy" && parts.length === 2) {
      const body = await readBody(req);
      const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 100) : "admin";
      const source = typeof body.source === "string" && body.source.trim() ? body.source.trim().slice(0, 1000) : null;
      try {
        deps.policy.replace(body.policy, { by, source, baseHash: String(body.baseHash ?? ""), now: Date.now() });
        send(res, 200, { policy: deps.policy.get(), hash: deps.policy.hash() });
      } catch (err) {
        if (err instanceof PolicyConflictError) send(res, 409, { error: err.message });
        else if (err instanceof Error && err.message.startsWith("Invalid policy")) send(res, 400, { error: err.message });
        else throw err;
      }
    } else {
      send(res, 404, { error: "Not found" });
    }
  } catch (err) {
    if (err instanceof DecisionError) send(res, err.status, { error: err.message });
    else if (err instanceof CompileError) send(res, 422, { error: err.message });
    else if (err instanceof Error && err.name.endsWith("APIError")) send(res, 502, { error: `AI request failed: ${err.message}` });
    else if (err instanceof SyntaxError) send(res, 400, { error: "Body must be JSON" });
    else send(res, 500, { error: (err as Error).message });
  }
  return true;
}
