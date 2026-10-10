// Tries each candidate PayPal sandbox MCP endpoint and transport with a real
// token and reports which ones work. Run with: npm run probe
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadConfig } from "../src/config.js";
import { PayPalTokenManager } from "../src/paypal/auth.js";

const HOST = "https://mcp.sandbox.paypal.com";
const CANDIDATES: Array<{ path: string; transport: "http" | "sse" }> = [
  { path: "/mcp", transport: "http" },
  { path: "/http", transport: "http" },
  { path: "/sse", transport: "sse" },
];

const config = loadConfig();
const tokens = new PayPalTokenManager(config.paypalBaseUrl, config.paypalClientId, config.paypalClientSecret);
const token = await tokens.getToken();
const withAuth: FetchLike = (url, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
};

for (const { path, transport } of CANDIDATES) {
  const url = new URL(path, HOST);
  const t: Transport =
    transport === "http"
      ? new StreamableHTTPClientTransport(url, { fetch: withAuth })
      : new SSEClientTransport(url, { fetch: withAuth });
  const client = new Client({ name: "handrail-probe", version: "0.1.0" });
  try {
    await client.connect(t);
    const { tools } = await client.listTools();
    console.log(`OK    ${transport.padEnd(4)} ${url}  (${tools.length} tools)`);
  } catch (err) {
    console.log(`FAIL  ${transport.padEnd(4)} ${url}  ${(err as Error).message.slice(0, 160)}`);
  } finally {
    await client.close().catch(() => {});
  }
}
