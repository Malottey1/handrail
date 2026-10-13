import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CompileError, compilePolicy } from "./ai/compile.js";
import type { Llm } from "./ai/llm.js";
import type { Approval, ApprovalStatus } from "./approvals.js";
import type { AuditChain } from "./audit-chain.js";
import type { CallLog } from "./audit.js";
import { AccountError, hasRole, normalizeEmail, normalizeName, ROLES, type AccountStore, type Role, type User } from "./auth/accounts.js";
import type { AgentKeyStore } from "./auth/agent-keys.js";
import {
  authenticate,
  clearSessionCookie,
  clientIp,
  ADMIN_SCRIPT,
  crossSite,
  csrfOk,
  setSessionCookie,
  type HttpOptions,
  type Principal,
} from "./auth/http.js";
import { hashPassword, passwordProblem, verifyPassword } from "./auth/passwords.js";
import { FailureLimiter } from "./auth/rate-limit.js";
import { DecisionError, type Gate } from "./gate.js";
import { PolicyConflictError, type PolicyStore } from "./policy/store.js";
import type { MatchStatus, WebhookStore } from "./webhooks.js";

export interface AdminDeps extends HttpOptions {
  gate: Gate;
  callLog: CallLog;
  webhooks: WebhookStore;
  audit: AuditChain;
  policy: PolicyStore;
  accounts: AccountStore;
  agentKeys: AgentKeyStore;
  /** For compiling plain-English rules. Null when AI features are off. */
  llm: Llm | null;
  /** Offer "Try the demo" (sign in as the shared demo approver). */
  demoAccess: boolean;
  now?: () => number;
}

const STATUSES = new Set<ApprovalStatus>(["pending", "executing", "executed", "failed", "blocked", "rejected", "expired"]);
const WINDOW_MS = 15 * 60 * 1000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(body, null, 2));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, isDemo: u.isDemo, createdAt: new Date(u.createdAt).toISOString(), disabled: u.disabledAt !== null };
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
    decidedById: a.decidedById,
    agent: a.agent,
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

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  now: number;
}

type Route = {
  method: string;
  /** Path segments after /api; ":x" matches any one segment. */
  path: string;
  role: Role;
  handle: (ctx: Ctx & { principal: Principal; params: string[] }) => Promise<void> | void;
};

function match(route: Route, method: string, parts: string[]): string[] | null {
  const pattern = route.path.split("/").filter(Boolean);
  if (route.method !== method || pattern.length !== parts.length - 1) return null;
  const params: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i]!.startsWith(":")) params.push(parts[i + 1]!);
    else if (pattern[i] !== parts[i + 1]) return null;
  }
  return params;
}

/**
 * Who to record as having acted: a signed-in user, or "Admin script" for the
 * admin token. A script may add a label (`by`), kept alongside the name.
 */
function actorOf(principal: Principal, body: Record<string, unknown>): { id: string; name: string } {
  if (principal.kind === "session") return { id: principal.user.id, name: principal.user.name };
  const label = text(body.by, 100);
  return { id: ADMIN_SCRIPT.id, name: label ? `${ADMIN_SCRIPT.name} (${label})` : ADMIN_SCRIPT.name };
}

const actorRef = (principal: Principal) => ({ id: principal.user.id, name: principal.user.name });

/**
 * REST API for the dashboard and scripts. Returns a request handler that
 * returns false when the request isn't an /api route.
 *
 * Public:   GET  /api/auth/session, GET /api/auth/invite?token=
 *           POST /api/auth/signup, /api/auth/login, /api/auth/demo
 * viewer:   GET  /api/summary, /api/approvals[/:id], /api/calls, /api/webhooks,
 *                /api/audit, /api/audit/verify, /api/policy
 *           POST /api/auth/logout; PATCH /api/me; POST /api/me/password
 * approver: POST /api/approvals/:id/approve | reject
 * admin:    POST /api/policy/compile; PUT /api/policy
 *           GET/PATCH /api/users[/:id]; GET/POST/DELETE /api/invites[/:id]
 *           GET/POST/DELETE /api/agent-keys[/:id]
 *
 * Every route but the public ones requires a session cookie (plus the CSRF
 * header on changes) or the HANDRAIL_ADMIN_TOKEN bearer token, and its role.
 */
export function createAdminApi(deps: AdminDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const clock = deps.now ?? Date.now;
  // Failed logins per account and address, and per address; sign-ups and demo sign-ins per address.
  const loginByAccount = new FailureLimiter(5, WINDOW_MS);
  const loginByIp = new FailureLimiter(30, WINDOW_MS);
  const signupByIp = new FailureLimiter(10, 60 * 60 * 1000);
  const demoByIp = new FailureLimiter(30, WINDOW_MS);
  const passwordByUser = new FailureLimiter(5, WINDOW_MS);

  function limit(limiter: FailureLimiter, key: string, now: number) {
    const wait = limiter.retryAfter(key, now);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`, { "Retry-After": String(seconds) });
    }
  }

  function startSession(ctx: Ctx, user: User) {
    const session = deps.accounts.createSession(user.id, ctx.now);
    setSessionCookie(ctx.req, ctx.res, session.token, session.expiresAt - ctx.now, deps);
    send(ctx.res, 200, { user: publicUser(user), csrfToken: session.csrf });
  }

  // ---- public routes

  async function publicRoute(ctx: Ctx): Promise<boolean> {
    const { req, res, parts, now } = ctx;
    if (parts[1] !== "auth") return false;
    const ip = clientIp(req, deps);

    if (req.method === "GET" && parts[2] === "session" && parts.length === 3) {
      const principal = authenticate(req, deps.accounts, deps, now);
      send(res, 200, {
        user: principal?.kind === "session" ? publicUser(principal.user) : null,
        csrfToken: principal?.kind === "session" ? principal.csrf : null,
        setupRequired: deps.accounts.countUsers() === 0,
        demoAccess: deps.demoAccess && deps.accounts.demoUser() !== null,
      });
      return true;
    }

    if (req.method === "GET" && parts[2] === "invite" && parts.length === 3) {
      const info = deps.accounts.inviteInfo(ctx.url.searchParams.get("token") ?? "", now);
      info ? send(res, 200, info) : send(res, 404, { error: "This invite link is invalid, used or expired." });
      return true;
    }

    if (req.method === "POST" && parts[2] === "signup" && parts.length === 3) {
      limit(signupByIp, ip, now);
      signupByIp.fail(ip, now); // every attempt counts
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      const name = normalizeName(body.name);
      const problem = passwordProblem(body.password);
      if (problem) throw new AccountError(problem, 400);
      const user = deps.accounts.signUp(
        { email, name, passwordHash: await hashPassword(body.password as string), inviteToken: text(body.invite, 200) },
        clock(),
      );
      startSession(ctx, user);
      return true;
    }

    if (req.method === "POST" && parts[2] === "login" && parts.length === 3) {
      const body = await readBody(req);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
      const accountKey = `${ip}|${email}`;
      limit(loginByIp, ip, now);
      limit(loginByAccount, accountKey, now);
      const found = email ? deps.accounts.forLogin(email) : null;
      const usable = found && !found.user.isDemo && found.user.disabledAt === null;
      const ok = await verifyPassword(usable ? found.passwordHash : null, typeof body.password === "string" ? body.password : "");
      if (!ok || !usable) {
        loginByIp.fail(ip, now);
        loginByAccount.fail(accountKey, now);
        throw new HttpError(401, "Wrong email or password.");
      }
      loginByAccount.reset(accountKey);
      startSession(ctx, found.user);
      return true;
    }

    if (req.method === "POST" && parts[2] === "demo" && parts.length === 3) {
      const demo = deps.demoAccess ? deps.accounts.demoUser() : null;
      if (!demo) throw new HttpError(404, "Demo access is turned off.");
      limit(demoByIp, ip, now);
      demoByIp.fail(ip, now);
      startSession(ctx, demo);
      return true;
    }

    return false;
  }

  // ---- signed-in routes

  const routes: Route[] = [
    { method: "POST", path: "auth/logout", role: "viewer", handle: ({ req, res, principal }) => {
      if (principal.kind === "session") deps.accounts.deleteSession(principal.token);
      clearSessionCookie(req, res, deps);
      send(res, 200, { ok: true });
    } },

    { method: "PATCH", path: "me", role: "viewer", handle: async ({ req, res, principal, now }) => {
      if (principal.kind !== "session") throw new HttpError(400, "Sign in as a user to edit a profile.");
      const body = await readBody(req);
      const user = deps.accounts.updateProfile(principal.user.id, { name: normalizeName(body.name), email: normalizeEmail(body.email) }, now);
      send(res, 200, { user: publicUser(user) });
    } },

    { method: "POST", path: "me/password", role: "viewer", handle: async ({ req, res, principal, now }) => {
      if (principal.kind !== "session") throw new HttpError(400, "Sign in as a user to change a password.");
      if (principal.user.isDemo) throw new AccountError("The demo account's password can't be changed.", 403);
      limit(passwordByUser, principal.user.id, now);
      const body = await readBody(req);
      const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
      if (!(await verifyPassword(deps.accounts.passwordHash(principal.user.id), current))) {
        passwordByUser.fail(principal.user.id, now);
        throw new HttpError(403, "Your current password is wrong.");
      }
      const problem = passwordProblem(body.newPassword);
      if (problem) throw new AccountError(problem, 400);
      deps.accounts.setPassword(principal.user.id, await hashPassword(body.newPassword as string), principal.token, clock());
      passwordByUser.reset(principal.user.id);
      send(res, 200, { ok: true });
    } },

    { method: "GET", path: "summary", role: "viewer", handle: ({ res }) => send(res, 200, summary(deps)) },

    { method: "GET", path: "approvals", role: "viewer", handle: ({ res, url }) => {
      const status = url.searchParams.get("status") as ApprovalStatus | null;
      if (status && !STATUSES.has(status)) throw new HttpError(400, `Unknown status ${status}`);
      send(res, 200, deps.gate.listApprovals(status ?? undefined).map(present));
    } },

    { method: "GET", path: "approvals/:id", role: "viewer", handle: ({ res, params }) => {
      const approval = deps.gate.getApproval(params[0]!);
      approval ? send(res, 200, present(approval)) : send(res, 404, { error: "Not found" });
    } },

    ...(["approve", "reject"] as const).map(
      (action): Route => ({ method: "POST", path: `approvals/:id/${action}`, role: "approver", handle: async ({ req, res, principal, params }) => {
        const body = await readBody(req);
        const by = actorOf(principal, body);
        const note = text(body.note, 500);
        const approval = action === "approve" ? await deps.gate.approve(params[0]!, by, note) : deps.gate.reject(params[0]!, by, note);
        send(res, 200, present(approval));
      } }),
    ),

    { method: "GET", path: "calls", role: "viewer", handle: ({ res, url }) => {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
      send(res, 200, deps.callLog.recent(limit));
    } },

    { method: "GET", path: "webhooks", role: "viewer", handle: ({ res, url }) => {
      const status = (url.searchParams.get("status") as MatchStatus | null) ?? undefined;
      send(res, 200, deps.webhooks.list(status).map(({ reasons_json, ...e }) => ({ ...e, reasons: JSON.parse(reasons_json) })));
    } },

    { method: "GET", path: "audit", role: "viewer", handle: ({ res, url }) => {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 1000);
      const rows = deps.audit.list(limit, url.searchParams.get("ref") ?? undefined);
      send(res, 200, rows.map(({ data_json, ...r }) => ({ ...r, data: JSON.parse(data_json) })));
    } },

    { method: "GET", path: "audit/verify", role: "viewer", handle: ({ res }) => send(res, 200, deps.audit.verify()) },

    { method: "GET", path: "policy", role: "viewer", handle: ({ res }) =>
      send(res, 200, { policy: deps.policy.get(), hash: deps.policy.hash(), ai: { enabled: !!deps.llm, model: deps.llm?.model ?? null } }) },

    { method: "POST", path: "policy/compile", role: "admin", handle: async ({ req, res }) => {
      if (!deps.llm) throw new HttpError(503, "AI features are off: set ANTHROPIC_API_KEY in .env");
      const body = await readBody(req);
      const baseHash = deps.policy.hash();
      const proposal = await compilePolicy(typeof body.instruction === "string" ? body.instruction : "", deps.policy.get(), deps.llm);
      send(res, 200, { ...proposal, baseHash, model: deps.llm.model });
    } },

    { method: "PUT", path: "policy", role: "admin", handle: async ({ req, res, principal }) => {
      const body = await readBody(req);
      const by = actorOf(principal, body);
      try {
        deps.policy.replace(body.policy, {
          by: by.name,
          byId: by.id,
          source: text(body.source, 1000),
          baseHash: String(body.baseHash ?? ""),
          now: clock(),
        });
      } catch (err) {
        if (err instanceof PolicyConflictError) throw new HttpError(409, err.message);
        if (err instanceof Error && err.message.startsWith("Invalid policy")) throw new HttpError(400, err.message);
        throw err;
      }
      send(res, 200, { policy: deps.policy.get(), hash: deps.policy.hash() });
    } },

    { method: "GET", path: "users", role: "admin", handle: ({ res }) => send(res, 200, deps.accounts.list().map(publicUser)) },

    { method: "PATCH", path: "users/:id", role: "admin", handle: async ({ req, res, principal, params, now }) => {
      const body = await readBody(req);
      if (body.role !== undefined && !ROLES.includes(body.role as Role)) throw new HttpError(400, `Role must be one of ${ROLES.join(", ")}`);
      const changes = {
        ...(body.role !== undefined ? { role: body.role as Role } : {}),
        ...(typeof body.disabled === "boolean" ? { disabled: body.disabled } : {}),
      };
      send(res, 200, publicUser(deps.accounts.setAccess(params[0]!, changes, actorRef(principal), now)));
    } },

    { method: "GET", path: "invites", role: "admin", handle: ({ res }) => send(res, 200, deps.accounts.listInvites()) },

    { method: "POST", path: "invites", role: "admin", handle: async ({ req, res, principal, now }) => {
      const body = await readBody(req);
      const role = (body.role ?? "viewer") as Role;
      if (!ROLES.includes(role)) throw new HttpError(400, `Role must be one of ${ROLES.join(", ")}`);
      const { invite, token } = deps.accounts.createInvite(normalizeEmail(body.email), role, actorRef(principal), now);
      // The token is in the link; it is shown once and only its hash is stored.
      send(res, 201, { invite, link: `/signup?invite=${token}` });
    } },

    { method: "DELETE", path: "invites/:id", role: "admin", handle: ({ res, principal, params, now }) => {
      deps.accounts.revokeInvite(params[0]!, actorRef(principal), now);
      send(res, 200, { ok: true });
    } },

    { method: "GET", path: "agent-keys", role: "admin", handle: ({ res }) => send(res, 200, deps.agentKeys.list()) },

    { method: "POST", path: "agent-keys", role: "admin", handle: async ({ req, res, principal, now }) => {
      const body = await readBody(req);
      const { key, secret } = deps.agentKeys.create(typeof body.name === "string" ? body.name : "", actorRef(principal), now);
      send(res, 201, { key, secret });
    } },

    { method: "DELETE", path: "agent-keys/:id", role: "admin", handle: ({ res, principal, params, now }) =>
      send(res, 200, deps.agentKeys.revoke(params[0]!, actorRef(principal), now)) },
  ];

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    const ctx: Ctx = { req, res, url, parts: url.pathname.split("/").filter(Boolean), now: clock() };

    try {
      if (crossSite(req)) throw new HttpError(403, "Cross-site request refused");
      if (await publicRoute(ctx)) return true;

      const principal = authenticate(req, deps.accounts, deps, ctx.now);
      if (!principal) throw new HttpError(401, "Sign in first");
      if (!csrfOk(req, principal)) throw new HttpError(403, "Missing or wrong CSRF token. Reload the page and try again.");

      const method = req.method ?? "GET";
      for (const route of routes) {
        const params = match(route, method, ctx.parts);
        if (!params) continue;
        if (!hasRole(principal.user.role, route.role)) {
          throw new HttpError(403, `This needs the ${route.role} role; you are ${principal.user.role === "admin" ? "an" : "a"} ${principal.user.role}.`);
        }
        await route.handle({ ...ctx, principal, params });
        return true;
      }
      throw new HttpError(404, "Not found");
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.message }, err.headers);
      else if (err instanceof AccountError) send(res, err.status, { error: err.message });
      else if (err instanceof DecisionError) send(res, err.status, { error: err.message });
      else if (err instanceof CompileError) send(res, 422, { error: err.message });
      else if (err instanceof Error && err.name.endsWith("APIError")) send(res, 502, { error: `AI request failed: ${err.message}` });
      else if (err instanceof SyntaxError) send(res, 400, { error: "Body must be JSON" });
      else send(res, 500, { error: (err as Error).message });
    }
    return true;
  };
}

/** A random password for the demo account; nobody ever uses it to sign in. */
export const demoPassword = () => randomBytes(32).toString("base64url");
