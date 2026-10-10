import { createServer, type IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { PayPalTokenManager } from "./paypal/auth.js";
import { connectUpstream } from "./paypal/upstream.js";
import { createProxyServer } from "./proxy.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const tokens = new PayPalTokenManager(config.paypalBaseUrl, config.paypalClientId, config.paypalClientSecret);
  await tokens.getToken(); // fail fast on bad credentials
  const upstream = await connectUpstream(config.paypalMcpUrl, tokens);
  const callLog = new CallLog(config.dbPath);

  const { tools } = await upstream.listTools();
  log(`Upstream exposes ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

  if (process.argv.includes("--stdio")) {
    await createProxyServer(upstream, callLog).connect(new StdioServerTransport());
    log("Serving MCP over stdio");
    return;
  }

  // Streamable HTTP, stateless: a fresh agent-facing server per request, all
  // sharing the one upstream connection. No agent auth yet, so bind to
  // localhost only until that exists.
  const host = process.env.HANDRAIL_HOST || "127.0.0.1";
  const http = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    try {
      const body = await readJson(req);
      const server = createProxyServer(upstream, callLog);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("Request failed:", (err as Error).message);
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null }),
        );
      }
    }
  });

  http.listen(config.port, host, () => log(`Serving MCP at http://${host}:${config.port}/mcp`));
}

main().catch((err) => {
  log("Fatal:", (err as Error).message);
  process.exit(1);
});
