import "dotenv/config";

export interface Config {
  paypalClientId: string;
  paypalClientSecret: string;
  paypalBaseUrl: string;
  /** Remote MCP URL, or "local" to spawn the @paypal/mcp package over stdio. */
  paypalMcpUrl: string;
  port: number;
  dbPath: string;
  policyPath: string;
  /** Bearer token for the admin API. Unset disables it. */
  adminToken: string | undefined;
  /** How long a held call waits inline for a human before returning "pending". */
  approvalWaitMs: number;
  /** How long a held call stays approvable. */
  approvalTtlMs: number;
  /** Identical calls (no idempotency_key) within this window count as one operation. */
  idempotencyWindowMs: number;
  /** Bearer token agents must send to /mcp over HTTP. Unset disables HTTP MCP (stdio still works). */
  agentToken: string | undefined;
  /** Webhook ID from the PayPal dashboard. Unset disables the webhook endpoint. */
  paypalWebhookId: string | undefined;
  /** Sandbox testing only: accept webhook events whose signature can't be verified. */
  allowUnverifiedWebhooks: boolean;
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

  return {
    paypalClientId: required("PAYPAL_CLIENT_ID"),
    paypalClientSecret: required("PAYPAL_CLIENT_SECRET"),
    paypalBaseUrl,
    paypalMcpUrl,
    port: Number(process.env.PORT) || 8787,
    dbPath: process.env.HANDRAIL_DB_PATH?.trim() || "handrail.db",
    policyPath: process.env.HANDRAIL_POLICY_PATH?.trim() || "policy.json",
    adminToken: token("HANDRAIL_ADMIN_TOKEN"),
    approvalWaitMs: positiveNumber("HANDRAIL_APPROVAL_WAIT_SECONDS", 20) * 1000,
    approvalTtlMs: positiveNumber("HANDRAIL_APPROVAL_TTL_MINUTES", 60) * 60 * 1000,
    idempotencyWindowMs: positiveNumber("HANDRAIL_IDEMPOTENCY_WINDOW_MINUTES", 60) * 60 * 1000,
    agentToken: token("HANDRAIL_AGENT_TOKEN"),
    paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() || undefined,
    allowUnverifiedWebhooks: process.env.HANDRAIL_WEBHOOK_ALLOW_UNVERIFIED?.trim() === "true",
  };
}
