import { createServer, type IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleAdmin } from "./admin-api.js";
import { ApprovalStore } from "./approvals.js";
import { CallLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { Gate } from "./gate.js";
import { log } from "./log.js";
import { PayPalTokenManager } from "./paypal/auth.js";
import { PayPalRest } from "./paypal/rest.js";
import { connectUpstream } from "./paypal/upstream.js";
import { loadPolicyFile } from "./policy/load.js";
import { createProxyServer } from "./proxy.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const stdio = process.argv.includes("--stdio");

  // Load the policy before touching PayPal: a bad policy should stop startup.
  const policy = loadPolicyFile(config.policyPath);
  log(`Loaded policy ${config.policyPath} with ${policy.rules.length} rules`);

  const tokens = new PayPalTokenManager(config.paypalBaseUrl, config.paypalClientId, config.paypalClientSecret);
  await tokens.getToken(); // fail fast on bad credentials
  const upstream = await connectUpstream(config.paypalMcpUrl, tokens);

  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const callLog = new CallLog(db);
  const gate = new Gate(upstream, new PayPalRest(config.paypalBaseUrl, tokens), callLog, new ApprovalStore(db), () => policy, {
    approvalWaitMs: config.approvalWaitMs,
    approvalTtlMs: config.approvalTtlMs,
  });

  const { tools } = await upstream.listTools();
  log(`Upstream exposes ${tools.length} tools`);

  // The HTTP server always runs: it carries the admin API (approvals), and the
  // agent-facing /mcp endpoint when not in stdio mode. No agent auth on /mcp
  // yet, so it binds to localhost unless HANDRAIL_HOST says otherwise.
  const host = process.env.HANDRAIL_HOST || "127.0.0.1";
  const http = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (await handleAdmin(req, res, { gate, callLog, policy: () => policy, adminToken: config.adminToken })) {
      return;
    }
    if (stdio || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    try {
      const body = await readJson(req);
      const server = createProxyServer(upstream, gate);
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

  http.on("error", (err: NodeJS.ErrnoException) => {
    if (stdio && err.code === "EADDRINUSE") {
      // Another Handrail owns the port; this stdio instance still works, but its
      // held calls must be approved through that instance's API.
      log(`Port ${config.port} is in use; admin API not started for this instance`);
      return;
    }
    log("Fatal:", err.message);
    process.exit(1);
  });

  http.listen(config.port, host, () => {
    log(`Admin API at http://${host}:${config.port}/api${config.adminToken ? "" : " (disabled: set HANDRAIL_ADMIN_TOKEN)"}`);
    if (!stdio) log(`Serving MCP at http://${host}:${config.port}/mcp`);
  });

  if (stdio) {
    await createProxyServer(upstream, gate).connect(new StdioServerTransport());
    log("Serving MCP over stdio");
  }
}

main().catch((err) => {
  log("Fatal:", (err as Error).message);
  process.exit(1);
});
