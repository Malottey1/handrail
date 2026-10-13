import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdminApi, demoPassword } from "./admin-api.js";
import { ApprovalStore } from "./approvals.js";
import { AuditChain } from "./audit-chain.js";
import { CallLog } from "./audit.js";
import { AccountStore } from "./auth/accounts.js";
import { AgentKeyStore, STDIO_AGENT } from "./auth/agent-keys.js";
import { hashPassword } from "./auth/passwords.js";
import { loadConfig } from "./config.js";
import { Gate } from "./gate.js";
import { OperationStore } from "./idempotency.js";
import { log } from "./log.js";
import { PayPalTokenManager } from "./paypal/auth.js";
import { PayPalDirect } from "./paypal/direct.js";
import { PayPalRest } from "./paypal/rest.js";
import { connectUpstream } from "./paypal/upstream.js";
import { AnthropicLlm } from "./ai/llm.js";
import { Explainer } from "./ai/explain.js";
import { loadPolicyFile } from "./policy/load.js";
import { PolicyStore } from "./policy/store.js";
import { handleMcp } from "./mcp-endpoint.js";
import { createProxyServer } from "./proxy.js";
import { serveDashboard } from "./static.js";
import { handleWebhook } from "./webhook-endpoint.js";
import { WebhookStore } from "./webhooks.js";

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
  const accounts = new AccountStore(db, audit);
  const agentKeys = new AgentKeyStore(db, audit);
  audit.start(Date.now());
  if (config.demoAccess) {
    const demo = accounts.ensureDemoUser(await hashPassword(demoPassword()), Date.now());
    log(`Demo access on: "Try the demo" signs in as ${demo.name} (approver)`);
  }
  const policyStore = new PolicyStore(config.policyPath, audit, policy);
  policyStore.recordLoaded(Date.now());

  // AI is advisory only: explanations for reviewers and drafting rules. The
  // gate's decisions never depend on it, and everything works without a key.
  const llm = config.anthropicApiKey ? new AnthropicLlm(config.anthropicApiKey, config.aiModel) : null;
  log(llm ? `AI features on (${config.aiModel})` : "AI features off: set ANTHROPIC_API_KEY to enable explanations and plain-English rules");
  const explainer = new Explainer(llm, approvals, callLog, () => policyStore.get());
  const gate = new Gate(
    {
      upstream,
      rest,
      direct: new PayPalDirect(config.paypalBaseUrl, tokens),
      callLog,
      approvals,
      operations,
      policy: () => policyStore.get(),
      onHeld: (approval) => void explainer.explain(approval),
    },
    { approvalWaitMs: config.approvalWaitMs, approvalTtlMs: config.approvalTtlMs },
  );

  const adminApi = createAdminApi({
    gate,
    callLog,
    webhooks,
    audit,
    policy: policyStore,
    llm,
    accounts,
    agentKeys,
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
    await handleMcp(req, res, { upstream, gate, agentKeys, agentToken: config.agentToken });
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
