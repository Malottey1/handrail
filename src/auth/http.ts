import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountStore, Role, User } from "./accounts.js";

export const SESSION_COOKIE = "handrail_session";
export const CSRF_HEADER = "x-csrf-token";

/**
 * Who is making an /api request:
 * - session: a person signed in to the dashboard (cookie + CSRF token)
 * - token:   a script using HANDRAIL_ADMIN_TOKEN as a bearer token (acts as admin,
 *            recorded as ADMIN_SCRIPT). Refused outright when the variable is unset.
 */
export type Principal =
  | { kind: "session"; user: User; csrf: string; token: string }
  | { kind: "token"; user: { id: string; name: string; role: Role } };

/** The identity recorded for anything done with HANDRAIL_ADMIN_TOKEN: never anonymous. */
export const ADMIN_SCRIPT = { id: "admin-script", name: "Admin script" } as const;

/**
 * The admin token is for local scripts only. A public deploy has accounts and
 * roles; a shared bearer token there would be one leaked secret away from full
 * admin, so Handrail refuses to start on Render with it set.
 */
export function checkAdminToken(token: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (token && (env.RENDER || env.RENDER_SERVICE_ID)) {
    throw new Error("HANDRAIL_ADMIN_TOKEN must not be set on Render. Remove it and sign in to the dashboard as an admin instead.");
  }
  return token;
}

export interface HttpOptions {
  adminToken: string | undefined;
  trustProxy: boolean;
  cookieSecure: boolean | "auto";
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

export function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req: IncomingMessage, opts: Pick<HttpOptions, "trustProxy">): string {
  const forwarded = opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
  return forwarded || req.socket.remoteAddress || "unknown";
}

function isHttps(req: IncomingMessage, opts: Pick<HttpOptions, "trustProxy">): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return opts.trustProxy && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Secure cookies need HTTPS; "auto" only drops the flag for plain HTTP on localhost (local development). */
function secureCookie(req: IncomingMessage, opts: Pick<HttpOptions, "trustProxy" | "cookieSecure">): boolean {
  if (opts.cookieSecure !== "auto") return opts.cookieSecure;
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  return isHttps(req, opts) || !LOCAL_HOSTS.has(host);
}

export function setSessionCookie(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  maxAgeMs: number,
  opts: Pick<HttpOptions, "trustProxy" | "cookieSecure">,
): void {
  const attrs = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secureCookie(req, opts)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function clearSessionCookie(req: IncomingMessage, res: ServerResponse, opts: Pick<HttpOptions, "trustProxy" | "cookieSecure">): void {
  setSessionCookie(req, res, "", 0, opts);
}

/**
 * The bearer admin token, or a valid session cookie. Null means unauthenticated.
 * With HANDRAIL_ADMIN_TOKEN unset, every bearer token is refused.
 */
export function authenticate(req: IncomingMessage, accounts: AccountStore, opts: HttpOptions, now: number): Principal | null {
  const token = bearer(req);
  if (token !== null) {
    return opts.adminToken && safeEqual(token, opts.adminToken)
      ? { kind: "token", user: { ...ADMIN_SCRIPT, role: "admin" } }
      : null;
  }
  const sessionToken = cookies(req).get(SESSION_COOKIE);
  if (!sessionToken) return null;
  const session = accounts.session(sessionToken, now);
  return session ? { kind: "session", user: session.user, csrf: session.csrf, token: sessionToken } : null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isStateChanging(req: IncomingMessage): boolean {
  return !SAFE_METHODS.has(req.method ?? "GET");
}

/**
 * Rejects state-changing requests from another site: the Origin (or Referer)
 * must match the Host. Applies to every /api request, including sign-in, so a
 * page elsewhere can't log a browser into someone else's account.
 */
export function crossSite(req: IncomingMessage): boolean {
  if (!isStateChanging(req)) return false;
  const source = req.headers.origin ?? req.headers.referer;
  if (!source) return false; // non-browser clients (scripts) send neither
  try {
    return new URL(source).host !== req.headers.host;
  } catch {
    return true;
  }
}

/** Cookie-authenticated changes must echo the session's CSRF token in a header. */
export function csrfOk(req: IncomingMessage, principal: Principal): boolean {
  if (principal.kind !== "session" || !isStateChanging(req)) return true;
  const given = req.headers[CSRF_HEADER];
  return typeof given === "string" && safeEqual(given, principal.csrf);
}
