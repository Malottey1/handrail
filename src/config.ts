import "dotenv/config";
import { checkAdminToken, checkSetupToken } from "./auth/http.js";
import { registerClientCredentials, registerSecrets } from "./redact.js";

export interface Config {
  paypalClientId: string;
  paypalClientSecret: string;
  paypalBaseUrl: string;
  /** Remote MCP URL, or "local" to spawn the @paypal/mcp package over stdio. */
  paypalMcpUrl: string;
  port: number;
  dbPath: string;
  policyPath: string;
  /** Bearer token for scripts using the admin API. Unset (the default, and required on Render) refuses all bearer tokens. */
  adminToken: string | undefined;
  /** Needed to create the first admin account; required on Render. */
  setupToken: string | undefined;
  /** How long a held call waits inline for a human before returning "pending". */
  approvalWaitMs: number;
  /** Identical calls (no idempotency_key) within this window count as one operation. */
  idempotencyWindowMs: number;
  /** Bearer token agents must send to /mcp over HTTP. Unset disables HTTP MCP (stdio still works). */
  agentToken: string | undefined;
  /** Webhook ID from the PayPal dashboard. Unset disables the webhook endpoint. */
  paypalWebhookId: string | undefined;
  /** Sandbox testing only: accept webhook events whose signature can't be verified. */
  allowUnverifiedWebhooks: boolean;
  /** Anthropic API key for explanations and policy compilation. Unset disables the AI features; enforcement never needs it. */
  anthropicApiKey: string | undefined;
  aiModel: string;
  /** Offer a "Try the demo" sign-in as a shared approver account (for hackathon judges). */
  demoAccess: boolean;
  /** Hosted on a plan that sleeps when idle (Render free): the homepage and sign-in say the first load can be slow. */
  freePlan: boolean;
  /** Behind a proxy (e.g. Render): use X-Forwarded-For / X-Forwarded-Proto for client IP and HTTPS. */
  trustProxy: boolean;
  /** Secure flag on the session cookie. "auto": on unless the dashboard is on localhost over plain HTTP. */
  cookieSecure: boolean | "auto";
  /** Held-call emails via Brevo. Null (alerts off) unless BREVO_API_KEY and HANDRAIL_ALERT_FROM are both set. */
  email: { brevoApiKey: string; from: { email: string; name: string } } | null;
  /** Where the dashboard is reachable, for links in alerts. */
  publicUrl: string;
}

function emailConfig(): Config["email"] {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const from = process.env.HANDRAIL_ALERT_FROM?.trim();
  if (!apiKey && !from) return null;
  if (!apiKey || !from) throw new Error("Set both BREVO_API_KEY and HANDRAIL_ALERT_FROM for email alerts (or neither, to turn them off).");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) throw new Error("HANDRAIL_ALERT_FROM must be an email address (a sender you verified in Brevo).");
  return { brevoApiKey: apiKey, from: { email: from, name: process.env.HANDRAIL_ALERT_FROM_NAME?.trim() || "Handrail" } };
}

function publicUrl(port: number): string {
  const raw = process.env.HANDRAIL_PUBLIC_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || `http://127.0.0.1:${port}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`HANDRAIL_PUBLIC_URL must be a URL like https://handrail.example.com, got ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("HANDRAIL_PUBLIC_URL must be http or https");
  return url.origin;
}

function token(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (value.length < 24) throw new Error(`${name} must be at least 24 characters (try: openssl rand -hex 32)`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got ${raw}`);
  return value;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function cookieSecure(raw: string | undefined): boolean | "auto" {
  if (!raw || raw === "auto") return "auto";
  if (raw === "true" || raw === "false") return raw === "true";
  throw new Error(`HANDRAIL_COOKIE_SECURE must be true, false or auto, got ${raw}`);
}

/**
 * Where the HTTP server listens: HANDRAIL_HOST, else every interface on Render
 * (its proxy has to reach the port), else localhost only.
 */
export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.HANDRAIL_HOST?.trim() || (env.RENDER || env.RENDER_SERVICE_ID ? "0.0.0.0" : "127.0.0.1");
}

export function loadConfig(): Config {
  const paypalBaseUrl = (process.env.PAYPAL_BASE_URL?.trim() || "https://api-m.sandbox.paypal.com").replace(/\/$/, "");

  // Handrail is sandbox-only during the hackathon. Refuse live endpoints outright.
  if (!paypalBaseUrl.includes("sandbox")) {
    throw new Error(`PAYPAL_BASE_URL must be a sandbox URL, got ${paypalBaseUrl}`);
  }

  const paypalMcpUrl = process.env.PAYPAL_MCP_URL?.trim() || "https://mcp.sandbox.paypal.com/sse";
  if (paypalMcpUrl !== "local" && !paypalMcpUrl.includes("sandbox")) {
    throw new Error(`PAYPAL_MCP_URL must be a sandbox URL or "local", got ${paypalMcpUrl}`);
  }

  const adminToken = checkAdminToken(token("HANDRAIL_ADMIN_TOKEN"), process.env);
  const setupToken = checkSetupToken(token("HANDRAIL_SETUP_TOKEN"), process.env);
  const paypalClientId = required("PAYPAL_CLIENT_ID");
  const paypalClientSecret = required("PAYPAL_CLIENT_SECRET");
  const agentToken = token("HANDRAIL_AGENT_TOKEN");
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  // From here on, these values are redacted wherever they'd appear (src/redact.ts).
  registerClientCredentials(paypalClientId, paypalClientSecret);
  const email = emailConfig();
  registerSecrets(adminToken, setupToken, agentToken, anthropicApiKey, email?.brevoApiKey);
  const port = Number(process.env.PORT) || 8787;

  return {
    paypalClientId,
    paypalClientSecret,
    paypalBaseUrl,
    paypalMcpUrl,
    port,
    dbPath: process.env.HANDRAIL_DB_PATH?.trim() || "handrail.db",
    policyPath: process.env.HANDRAIL_POLICY_PATH?.trim() || "policy.json",
    adminToken,
    setupToken,
    approvalWaitMs: positiveNumber("HANDRAIL_APPROVAL_WAIT_SECONDS", 20) * 1000,
    idempotencyWindowMs: positiveNumber("HANDRAIL_IDEMPOTENCY_WINDOW_MINUTES", 60) * 60 * 1000,
    agentToken,
    paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() || undefined,
    allowUnverifiedWebhooks: process.env.HANDRAIL_WEBHOOK_ALLOW_UNVERIFIED?.trim() === "true",
    anthropicApiKey,
    aiModel: process.env.HANDRAIL_AI_MODEL?.trim() || "claude-opus-5-5",
    demoAccess: process.env.HANDRAIL_DEMO_ACCESS?.trim() === "true",
    freePlan: process.env.HANDRAIL_FREE_PLAN?.trim() === "true",
    trustProxy: process.env.HANDRAIL_TRUST_PROXY?.trim() === "true",
    cookieSecure: cookieSecure(process.env.HANDRAIL_COOKIE_SECURE?.trim()),
    email,
    publicUrl: publicUrl(port),
  };
}
