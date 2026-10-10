import "dotenv/config";

export interface Config {
  paypalClientId: string;
  paypalClientSecret: string;
  paypalBaseUrl: string;
  /** Remote MCP URL, or "local" to spawn the @paypal/mcp package over stdio. */
  paypalMcpUrl: string;
  port: number;
  dbPath: string;
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
    port: Number(process.env.PORT) || 3000,
    dbPath: process.env.HANDRAIL_DB_PATH?.trim() || "handrail.db",
  };
}
