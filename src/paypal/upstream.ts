import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { log } from "../log.js";
import type { PayPalTokenManager } from "./auth.js";

const CLIENT_INFO = { name: "handrail", version: "0.1.0" };

/**
 * A fetch that attaches a current PayPal bearer token to every request, so a
 * long-lived upstream connection keeps working across token refreshes.
 */
function authorizedFetch(tokens: PayPalTokenManager): FetchLike {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${await tokens.getToken()}`);
    return fetch(url, { ...init, headers });
  };
}

/**
 * Connects to PayPal's MCP server as a client.
 *
 * - A URL ending in /sse connects over SSE. PayPal's sandbox only serves SSE
 *   (verified: /mcp and /http return 404 with a valid token).
 * - Any other URL tries Streamable HTTP first, then SSE.
 * - "local" spawns PayPal's @paypal/mcp package over stdio. That package reads
 *   the token once at startup, so this mode does not yet survive token expiry.
 */
export async function connectUpstream(mcpUrl: string, tokens: PayPalTokenManager): Promise<Client> {
  if (mcpUrl === "local") {
    const client = new Client(CLIENT_INFO);
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["-y", "@paypal/mcp", "--tools=all"],
        env: {
          ...getDefaultEnvironment(),
          PAYPAL_ACCESS_TOKEN: await tokens.getToken(),
          PAYPAL_ENVIRONMENT: "SANDBOX",
        },
        stderr: "inherit",
      }),
    );
    log("Connected to local @paypal/mcp over stdio");
    return client;
  }

  const url = new URL(mcpUrl);
  const fetch = authorizedFetch(tokens);

  if (!url.pathname.endsWith("/sse")) {
    try {
      const client = new Client(CLIENT_INFO);
      await client.connect(new StreamableHTTPClientTransport(url, { fetch }));
      log(`Connected to ${url} over Streamable HTTP`);
      return client;
    } catch (err) {
      log(`Streamable HTTP failed (${(err as Error).message}); trying SSE`);
    }
  }

  const client = new Client(CLIENT_INFO);
  await client.connect(new SSEClientTransport(url, { fetch }));
  log(`Connected to ${url} over SSE`);
  return client;
}
