import { createServer, type IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authorized, handleAdmin } from "./admin-api.js";
import { ApprovalStore } from "./approvals.js";
import { AuditChain } from "./audit-chain.js";
import { CallLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { Gate } from "./gate.js";
import { OperationStore } from "./idempotency.js";
import { log } from "./log.js";
import { PayPalTokenManager } from "./paypal/auth.js";
import { PayPalDirect } from "./paypal/direct.js";
import { PayPalRest } from "./paypal/rest.js";
import { connectUpstream } from "./paypal/upstream.js";
import { loadPolicyFile } from "./policy/load.js";
import { createProxyServer } from "./proxy.js";
import { serveDashboard } from "./static.js";
import { handleWebhook } from "./webhook-endpoint.js";
import { WebhookStore } from "./webhooks.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** The built React dashboard (npm run build:web). */
const DASHBOARD_DIR = process.env.HANDRAIL_DASHBOARD_DIR?.trim() || "web/dist";

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
  const audit = new AuditChain(db);
  const callLog = new CallLog(db, audit);
  const rest = new PayPalRest(config.paypalBaseUrl, tokens);
  const webhooks = new WebhookStore(db, audit);
  const approvals = new ApprovalStore(db, audit);
  const operations = new OperationStore(db, config.idempotencyWindowMs);
  audit.start(Date.now());
  const gate = new Gate(
    {
      upstream,
      rest,
      direct: new PayPalDirect(config.paypalBaseUrl, tokens),
      callLog,
      approvals,
      operations,
      policy: () => policy,
    },
    { approvalWaitMs: config.approvalWaitMs, approvalTtlMs: config.approvalTtlMs },
  );

  const { tools } = await upstream.listTools();
  log(`Upstream exposes ${tools.length} tools`);

  // The HTTP server always runs. It carries the admin API (approvals), the
  // PayPal webhook endpoint, and the agent-facing /mcp endpoint when not in
  // stdio mode. Binds to localhost unless HANDRAIL_HOST says otherwise.
  const host = process.env.HANDRAIL_HOST || "127.0.0.1";
  const http = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (path === "/webhooks/paypal" && req.method === "POST") {
      await handleWebhook(req, res, {
        rest,
        callLog,
        store: webhooks,
        webhookId: config.paypalWebhookId,
        allowUnverified: config.allowUnverifiedWebhooks,
      });
      return;
    }
    if (await handleAdmin(req, res, { gate, callLog, webhooks, audit, policy: () => policy, adminToken: config.adminToken })) {
      return;
    }
    if (path !== "/mcp" && (await serveDashboard(req, res, DASHBOARD_DIR))) {
      return;
    }
    if (stdio || path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    // /mcp can move money, so it needs the agent token, even on localhost:
    // a tunnel (e.g. for webhooks) would otherwise expose it.
    if (!config.agentToken) {
      res.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"HTTP MCP disabled: set HANDRAIL_AGENT_TOKEN in .env"}');
      return;
    }
    if (!authorized(req, config.agentToken)) {
      res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"Missing or wrong agent token"}');
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
    log(`Dashboard at http://${host}:${config.port}/${config.adminToken ? "" : " (needs HANDRAIL_ADMIN_TOKEN)"}`);
    log(`Admin API at http://${host}:${config.port}/api${config.adminToken ? "" : " (disabled: set HANDRAIL_ADMIN_TOKEN)"}`);
    if (!stdio) log(`MCP at http://${host}:${config.port}/mcp${config.agentToken ? "" : " (disabled: set HANDRAIL_AGENT_TOKEN)"}`);
    log(`PayPal webhooks at http://${host}:${config.port}/webhooks/paypal${config.paypalWebhookId ? "" : " (disabled: set PAYPAL_WEBHOOK_ID)"}`);
    if (config.allowUnverifiedWebhooks) log("WARNING: accepting unverified webhook events (HANDRAIL_WEBHOOK_ALLOW_UNVERIFIED=true)");
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
