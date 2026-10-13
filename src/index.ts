import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdminApi, demoPassword } from "./admin-api.js";
import { AuditChain } from "./audit-chain.js";
import { AccountStore } from "./auth/accounts.js";
import { STDIO_AGENT } from "./auth/agent-keys.js";
import { hashPassword } from "./auth/passwords.js";
import { loadConfig } from "./config.js";
import { createDemoSale } from "./demo/sale.js";
import { DemoService } from "./demo/workspaces.js";
import { log } from "./log.js";
import { PayPalTokenManager } from "./paypal/auth.js";
import { PayPalDirect } from "./paypal/direct.js";
import { PayPalRest } from "./paypal/rest.js";
import { connectUpstream } from "./paypal/upstream.js";
import { AnthropicLlm } from "./ai/llm.js";
import { loadPolicyFile } from "./policy/load.js";
import { handleMcp } from "./mcp-endpoint.js";
import { createProxyServer, SERVER_INFO } from "./proxy.js";
import { serveDashboard } from "./static.js";
import { handleWebhook } from "./webhook-endpoint.js";
import { openWorkspace } from "./workspace.js";

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

  const rest = new PayPalRest(config.paypalBaseUrl, tokens);
  const direct = new PayPalDirect(config.paypalBaseUrl, tokens);

  // AI is advisory only: explanations for reviewers and drafting rules. The
  // gate's decisions never depend on it, and everything works without a key.
  const llm = config.anthropicApiKey ? new AnthropicLlm(config.anthropicApiKey, config.aiModel) : null;
  log(llm ? `AI features on (${config.aiModel})` : "AI features off: set ANTHROPIC_API_KEY to enable explanations and plain-English rules");

  const shared = {
    upstream,
    rest,
    direct,
    llm,
    approvalWaitMs: config.approvalWaitMs,
    approvalTtlMs: config.approvalTtlMs,
    idempotencyWindowMs: config.idempotencyWindowMs,
  };

  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const audit = new AuditChain(db);
  const accounts = new AccountStore(db, audit);
  const workspace = openWorkspace({ ...shared, db, audit, policy, policyPath: config.policyPath });
  const { gate, callLog, webhooks, agentKeys } = workspace;

  // The demo agent calls Handrail's own /mcp with its key, like any outside agent.
  const host = process.env.HANDRAIL_HOST || "127.0.0.1";
  const loopback = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const demo = config.demoAccess
    ? new DemoService({
        realDb: db,
        // Each demo session starts from the policy in force, in memory, with nothing else.
        open: () => {
          const demoDb = new DatabaseSync(":memory:");
          return openWorkspace({ ...shared, db: demoDb, audit: new AuditChain(demoDb), policy: workspace.policy.get(), policyPath: null });
        },
        connect: async (agentKey) => {
          if (stdio) throw new Error("The demo agent needs Handrail running over HTTP (npm run dev), not stdio.");
          const client = new Client({ name: "handrail-demo-agent", version: SERVER_INFO.version });
          const url = new URL(`http://${loopback}:${config.port}/mcp`);
          await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${agentKey}` } } }));
          return client;
        },
        createSale: (amount) => createDemoSale(config.paypalBaseUrl, tokens, amount),
      })
    : null;
  if (config.demoAccess) {
    const demoUser = accounts.ensureDemoUser(await hashPassword(demoPassword()), Date.now());
    log(`Demo access on: "Try the demo" signs in as ${demoUser.name} (approver), in a separate workspace per session`);
  }

  const adminApi = createAdminApi({
    workspace,
    accounts,
    llm,
    demo,
    adminToken: config.adminToken,
    demoAccess: config.demoAccess,
    trustProxy: config.trustProxy,
    cookieSecure: config.cookieSecure,
  });

  const { tools } = await upstream.listTools();
  log(`Upstream exposes ${tools.length} tools`);

  // The HTTP server always runs. It carries the admin API (approvals), the
  // PayPal webhook endpoint, and the agent-facing /mcp endpoint when not in
  // stdio mode. Binds to localhost unless HANDRAIL_HOST says otherwise.
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
        demo: demo && { routeWebhook: (ids) => demo.routeWebhook(ids) },
        webhookId: config.paypalWebhookId,
        allowUnverified: config.allowUnverifiedWebhooks,
      });
      return;
    }
    if (await adminApi(req, res)) {
      return;
    }
    if (path !== "/mcp" && (await serveDashboard(req, res, DASHBOARD_DIR))) {
      return;
    }
    if (stdio || path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    await handleMcp(req, res, { upstream, gate, agentKeys, agentToken: config.agentToken, demo });
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
    log(`Dashboard at http://${host}:${config.port}/${accounts.countUsers() === 0 ? " (no accounts yet: the first sign-up becomes admin)" : ""}`);
    log(`Admin API at http://${host}:${config.port}/api (dashboard sessions${config.adminToken ? " or HANDRAIL_ADMIN_TOKEN" : ""})`);
    if (!stdio) log(`MCP at http://${host}:${config.port}/mcp (agent keys from the dashboard${config.agentToken ? " or HANDRAIL_AGENT_TOKEN" : ""})`);
    log(`PayPal webhooks at http://${host}:${config.port}/webhooks/paypal${config.paypalWebhookId ? "" : " (disabled: set PAYPAL_WEBHOOK_ID)"}`);
    if (config.allowUnverifiedWebhooks) log("WARNING: accepting unverified webhook events (HANDRAIL_WEBHOOK_ALLOW_UNVERIFIED=true)");
  });

  if (stdio) {
    // A stdio agent started Handrail itself, with access to .env; it's recorded as the local agent.
    await createProxyServer(upstream, gate, STDIO_AGENT).connect(new StdioServerTransport());
    log("Serving MCP over stdio");
  }
}

main().catch((err) => {
  log("Fatal:", (err as Error).message);
  process.exit(1);
});
