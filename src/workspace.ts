import type { DatabaseSync } from "node:sqlite";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Explainer } from "./ai/explain.js";
import type { Llm } from "./ai/llm.js";
import { ApprovalStore, type Approval } from "./approvals.js";
import type { AuditChain } from "./audit-chain.js";
import { CallLog } from "./audit.js";
import { AgentKeyStore } from "./auth/agent-keys.js";
import { Gate } from "./gate.js";
import { OperationStore } from "./idempotency.js";
import { log } from "./log.js";
import { AlertStore, type HeldNotifier } from "./notify/notifier.js";
import type { PayPalDirect } from "./paypal/direct.js";
import type { PayPalRest } from "./paypal/rest.js";
import { PolicyStore } from "./policy/store.js";
import type { Policy } from "./policy/types.js";
import { WebhookStore } from "./webhooks.js";

/**
 * Everything one set of agent activity lives in: its database, audit chain,
 * call log, approvals, webhooks, policy, agent keys and the gate in front of
 * PayPal. The real deployment has one; each demo session gets its own
 * (src/demo/workspaces.ts), so demo activity never mixes with real data.
 */
export interface Workspace {
  db: DatabaseSync;
  audit: AuditChain;
  callLog: CallLog;
  approvals: ApprovalStore;
  webhooks: WebhookStore;
  agentKeys: AgentKeyStore;
  policy: PolicyStore;
  gate: Gate;
  /** Held-call alerts: what was sent (or, in a demo, previewed) for each held call. */
  alerts: AlertStore;
  notifier: HeldNotifier;
  close(): void;
}

export interface WorkspaceOptions {
  db: DatabaseSync;
  audit: AuditChain;
  upstream: Client;
  rest: PayPalRest;
  direct: Pick<PayPalDirect, "call"> & Partial<Pick<PayPalDirect, "read">>;
  /** For reviewer briefs. Null when AI features are off. */
  llm: Llm | null;
  policy: Policy;
  /** Where the policy is saved; null keeps it in memory (demo workspaces). */
  policyPath: string | null;
  approvalWaitMs: number;
  /** Overrides the policy's hold expiry (tests). */
  approvalTtlMs?: number;
  idempotencyWindowMs: number;
  /** Builds the alert sender: live (email, Slack) for the real workspace, previews for demos. */
  notifier: (alerts: AlertStore) => HeldNotifier;
  /** How long an alert waits for the AI brief before going out without it. Default 20 s. */
  alertWaitMs?: number;
  now?: () => number;
}

/**
 * Creates the stores, starts the audit chain (snapshotting any rows that
 * predate it), records the policy in force, and builds the gate. Tables
 * created by the caller on the same database before this (e.g. accounts) are
 * covered by the chain too.
 */
export function openWorkspace(opts: WorkspaceOptions): Workspace {
  const { db, audit } = opts;
  const now = opts.now ?? Date.now;
  const callLog = new CallLog(db, audit);
  const webhooks = new WebhookStore(db, audit);
  const approvals = new ApprovalStore(db, audit);
  const operations = new OperationStore(db, opts.idempotencyWindowMs);
  const agentKeys = new AgentKeyStore(db, audit);
  audit.start(now());

  const policy = new PolicyStore(opts.policyPath, audit, opts.policy);
  policy.recordLoaded(now());

  // AI is advisory only: the gate's decisions never depend on it.
  const explainer = new Explainer(opts.llm, approvals, callLog, () => policy.get(), now);
  const alerts = new AlertStore(db, audit);
  const notifier = opts.notifier(alerts);
  const alertWaitMs = opts.alertWaitMs ?? 20_000;

  // After a call is held: write the AI brief, then alert approvers with its
  // one-line summary (or without it, if it takes longer than alertWaitMs).
  // Both run after the decision is recorded and can't change it.
  const onHeld = (approval: Approval) => {
    const brief = explainer.explain(approval);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, alertWaitMs).unref()));
    void Promise.race([brief, timeout])
      .then(() => {
        clearTimeout(timer);
        return notifier.held(approvals.get(approval.id) ?? approval);
      })
      .catch((err: Error) => log(`Alert for ${approval.id} failed: ${err.message}`));
  };
  const gate = new Gate(
    {
      upstream: opts.upstream,
      rest: opts.rest,
      direct: opts.direct,
      callLog,
      approvals,
      operations,
      policy: () => policy.get(),
      onHeld,
    },
    { approvalWaitMs: opts.approvalWaitMs, approvalTtlMs: opts.approvalTtlMs, now: opts.now },
  );

  return {
    db,
    audit,
    callLog,
    approvals,
    webhooks,
    agentKeys,
    policy,
    gate,
    alerts,
    notifier,
    close() {
      gate.close();
      db.close();
    },
  };
}
