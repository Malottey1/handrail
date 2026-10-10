import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Approval, ApprovalStatus } from "./approvals.js";
import type { CallLog } from "./audit.js";
import { DecisionError, type Gate } from "./gate.js";
import type { Policy } from "./policy/types.js";

export interface AdminDeps {
  gate: Gate;
  callLog: CallLog;
  policy: () => Policy;
  /** Bearer token required on every /api request. Unset disables the API. */
  adminToken: string | undefined;
}

const STATUSES = new Set<ApprovalStatus>(["pending", "executing", "executed", "failed", "blocked", "rejected", "expired"]);

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body, null, 2));
}

function authorized(req: IncomingMessage, token: string): boolean {
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
  };
}

/**
 * REST API for humans (and later the dashboard). Returns false if the request
 * isn't an /api route.
 *
 *   GET  /api/approvals?status=pending
 *   GET  /api/approvals/:id
 *   POST /api/approvals/:id/approve   { "by": "name", "note": "..." }
 *   POST /api/approvals/:id/reject    { "by": "name", "note": "..." }
 *   GET  /api/calls?limit=50
 *   GET  /api/policy
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
    if (req.method === "GET" && parts[1] === "approvals" && parts.length === 2) {
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
    } else if (req.method === "GET" && parts[1] === "policy" && parts.length === 2) {
      send(res, 200, deps.policy());
    } else {
      send(res, 404, { error: "Not found" });
    }
  } catch (err) {
    if (err instanceof DecisionError) send(res, err.status, { error: err.message });
    else if (err instanceof SyntaxError) send(res, 400, { error: "Body must be JSON" });
    else send(res, 500, { error: (err as Error).message });
  }
  return true;
}
