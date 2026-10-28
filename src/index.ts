import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { withErrorBoundary } from "./error-boundary.js";
import { DemoService } from "./demo/workspaces.js";
import { log } from "./log.js";
import { PayPalTokenManager } from "./paypal/auth.js";
import { PayPalDirect } from "./paypal/direct.js";
import { PayPalRest } from "./paypal/rest.js";
import { connectUpstream } from "./paypal/upstream.js";
import { AnthropicLlm } from "./ai/llm.js";
import { loadPolicyFile, seedPolicyFile } from "./policy/load.js";
import { describeStorage, storageStatus } from "./storage.js";
import { handleMcp } from "./mcp-endpoint.js";
import { handleToolApi } from "./tool-api.js";
import { createProxyServer, SERVER_INFO } from "./proxy.js";
import { serveDashboard } from "./static.js";
import { handleWebhook } from "./webhook-endpoint.js";
import { openWorkspace } from "./workspace.js";
import { BrevoEmail, postToSlack } from "./notify/channels.js";
import { LiveNotifier, PreviewNotifier } from "./notify/notifier.js";
import { SettingsStore } from "./notify/settings.js";

/** The built React dashboard (npm run build:web). */
const DASHBOARD_DIR = process.env.HANDRAIL_DASHBOARD_DIR?.trim() || "web/dist";

/** The committed default policy, copied to HANDRAIL_POLICY_PATH when that file doesn't exist yet. */
const DEFAULT_POLICY = "policy.json";

async function main(): Promise<void> {
  const config = loadConfig();
  const stdio = process.argv.includes("--stdio");

  // Load the policy before touching PayPal: a bad policy should stop startup.
  if (seedPolicyFile(config.policyPath, DEFAULT_POLICY)) log(`No policy at ${config.policyPath}; copied the default from ${DEFAULT_POLICY}`);
  const policy = loadPolicyFile(config.policyPath);
  log(`Loaded policy ${config.policyPath} with ${policy.rules.length} rules`);
  const storage = storageStatus(config.dbPath, config.policyPath, process.env);
  log(`Storage: ${describeStorage(storage)}`);

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
    idempotencyWindowMs: config.idempotencyWindowMs,
  };

  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const audit = new AuditChain(db);
  const accounts = new AccountStore(db, audit);
  const settings = new SettingsStore(db, audit);

  // Held-call alerts: email (Brevo) to approvers and admins who want them, and
  // Slack if an admin set a webhook. With neither, they're off: nothing is sent.
  const email = config.email ? new BrevoEmail(config.email.brevoApiKey, config.email.from) : null;
  const workspace = openWorkspace({
    ...shared,
    db,
    audit,
    policy,
    policyPath: config.policyPath,
    notifier: (alerts) =>
      new LiveNotifier({
        email,
        slackWebhook: () => settings.slackWebhook(),
        postSlack: postToSlack,
        recipients: () => accounts.alertRecipients(),
        baseUrl: config.publicUrl,
        alerts,
      }),
  });
  log(
    email || settings.slackWebhook()
      ? `Held-call alerts on (${[email && "email", settings.slackWebhook() && "Slack"].filter(Boolean).join(" and ")}); links point to ${config.publicUrl}`
      : "Held-call alerts off: set BREVO_API_KEY and HANDRAIL_ALERT_FROM, or add a Slack webhook in the dashboard",
  );
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
          // Demo workspaces never send email or Slack messages: alerts are previews in the dashboard.
          return openWorkspace({
            ...shared,
            db: demoDb,
            audit: new AuditChain(demoDb),
            policy: workspace.policy.get(),
            policyPath: null,
            notifier: (alerts) => new PreviewNotifier(alerts, config.publicUrl),
          });
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
    settings,
    email,
    setup: { publicUrl: config.publicUrl, webhooksConfigured: !!config.paypalWebhookId },
    llm,
    demo,
    adminToken: config.adminToken,
    setupToken: config.setupToken,
    storage,
    demoAccess: config.demoAccess,
    trustProxy: config.trustProxy,
    cookieSecure: config.cookieSecure,
  });

  const { tools } = await upstream.listTools();
  log(`Upstream exposes ${tools.length} tools`);

  // The HTTP server always runs. It carries the admin API (approvals), the
  // PayPal webhook endpoint, and the agent-facing /mcp endpoint when not in
  // stdio mode. Binds to localhost unless HANDRAIL_HOST says otherwise.
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
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
        notifier: workspace.notifier,
        webhookId: config.paypalWebhookId,
        allowUnverified: config.allowUnverifiedWebhooks,
      });
      return;
    }
    if (await adminApi(req, res)) {
      return;
    }
    // The REST tool-call API: same tools and pipeline as /mcp, for frameworks that don't speak MCP.
    if (!stdio && (await handleToolApi(req, res, { upstream, gate, agentKeys, agentToken: config.agentToken, demo }))) {
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
  };
  const http = createServer(withErrorBoundary(handleRequest));

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
    if (!stdio) log(`Tool-call API at http://${host}:${config.port}/v1/tools (same agent keys)`);
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
