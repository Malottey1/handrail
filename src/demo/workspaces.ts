import type { DatabaseSync } from "node:sqlite";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { tokenHash } from "../auth/accounts.js";
import type { AgentIdentity } from "../auth/agent-keys.js";
import { FailureLimiter } from "../auth/rate-limit.js";
import type { Gate } from "../gate.js";
import { log } from "../log.js";
import type { Workspace } from "../workspace.js";
import { newDemoRun, planDemo, runDemoAgent, type DemoRun } from "./agent.js";
import type { DemoSale } from "./sale.js";

export const DEMO_AGENT_NAME = "Demo agent";
const DEMO_SYSTEM = { id: "handrail-demo", name: "Handrail demo" };

export interface DemoOptions {
  /** The real database: only remembers which PayPal objects demo runs created, so their webhooks stay out of real data. */
  realDb: DatabaseSync;
  /** A fresh, empty workspace (in-memory database). */
  open(): Workspace;
  /** An MCP client for Handrail's own /mcp, authenticated with `agentKey`. */
  connect(agentKey: string): Promise<Client>;
  createSale(amount: string): Promise<DemoSale>;
  /** A workspace nobody has used for this long is discarded. Default 2 hours. */
  idleMs?: number;
  /** Most workspaces kept at once; the least recently used idle one goes first. Default 50. */
  maxWorkspaces?: number;
  now?: () => number;
}

export class DemoError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

interface Entry {
  workspace: Workspace;
  agentKey: string;
  agentKeyId: string;
  lastUsedAt: number;
  /** PayPal order and capture ids this workspace's runs created. */
  resources: Set<string>;
  run: DemoRun | null;
}

/**
 * Demo isolation. Every demo sign-in gets its own workspace: a separate
 * in-memory database with its own call log, approvals, webhooks, audit chain,
 * policy (a copy of the real one) and a "Demo agent" key. Judges using the
 * demo at the same time never see or decide each other's calls, rate and
 * spend limits count only their own runs, and nothing they do touches real
 * data. Workspaces are discarded after `idleMs` without use.
 *
 * Each run after the first starts in a fresh workspace.
 *
 * Runs are limited: one at a time per workspace, one per minute per session,
 * 10 per hour per address and 60 per hour overall, since each makes real
 * sandbox calls and (with AI on) a model call.
 */
export class DemoService {
  private readonly entries = new Map<string, Entry>();
  /** Agent key hash -> session key. */
  private readonly byAgentKey = new Map<string, string>();
  private readonly perSession = new FailureLimiter(1, 60_000);
  private readonly perIp = new FailureLimiter(10, 3_600_000);
  private readonly overall = new FailureLimiter(60, 3_600_000);
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxWorkspaces: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly opts: DemoOptions) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? 2 * 3_600_000;
    this.maxWorkspaces = opts.maxWorkspaces ?? 50;
    opts.realDb.exec(`CREATE TABLE IF NOT EXISTS demo_resources (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`);
    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000).unref();
  }

  /** The workspace for a demo session, created on first use. */
  workspace(sessionToken: string): Workspace {
    return this.entry(sessionToken).workspace;
  }

  /** For /mcp: the demo agent and the gate of the workspace its key belongs to. */
  authenticateAgent(secret: string): { agent: AgentIdentity; gate: Gate } | null {
    const key = this.byAgentKey.get(tokenHash(secret));
    const entry = key ? this.entries.get(key) : undefined;
    const agent = entry?.workspace.agentKeys.authenticate(secret, this.now());
    if (!entry || !agent) return null;
    entry.lastUsedAt = this.now();
    return { agent, gate: entry.workspace.gate };
  }

  status(sessionToken: string) {
    const key = tokenHash(sessionToken);
    const entry = this.entry(sessionToken);
    const now = this.now();
    const run = entry.run;
    // The held refund's live state, so the panel can say whether a person has decided yet.
    const approval = run?.captureId
      ? entry.workspace.approvals.list().find((a) => a.facts.args.capture_id === run.captureId) ?? null
      : null;
    const wait = Math.max(this.perSession.retryAfter(key, now), run?.status === "running" ? 1 : 0);
    return {
      run,
      approval: approval && { id: approval.id, status: approval.status, decidedBy: approval.decidedBy },
      nextRunInSeconds: Math.ceil(wait / 1000),
      resetsAfterMinutes: Math.round(this.idleMs / 60_000),
    };
  }

  /** Starts the demo agent in the background and returns the run, which fills in as it goes. */
  start(sessionToken: string, ip: string): DemoRun {
    const key = tokenHash(sessionToken);
    let entry = this.entry(sessionToken);
    const now = this.now();
    if (entry.run?.status === "running") throw new DemoError(409, "The demo agent is already running.");
    for (const [limiter, k, what] of [
      [this.perSession, key, "once a minute"],
      [this.perIp, ip, "10 times an hour from one address"],
      [this.overall, "all", "60 times an hour in total"],
    ] as const) {
      const wait = limiter.retryAfter(k, now);
      if (wait > 0) throw new DemoError(429, `The demo agent can run ${what}. Try again in ${Math.ceil(wait / 1000)} seconds.`, Math.ceil(wait / 1000));
    }

    const plan = planDemo(entry.workspace.policy.get());
    if (typeof plan === "string") throw new DemoError(409, plan);

    this.perSession.fail(key, now);
    this.perIp.fail(ip, now);
    this.overall.fail("all", now);

    // Each run after the first starts in a fresh workspace, so the last run's
    // refunds don't count against this one's rate and spend limits.
    if (entry.run) {
      this.discard(key);
      entry = this.entry(sessionToken);
    }

    const run = newDemoRun(plan, now);
    entry.run = run;
    void runDemoAgent(run, {
      connect: () => this.opts.connect(entry.agentKey),
      createSale: (amount) => this.opts.createSale(amount),
      onSale: (sale) => this.remember(entry, [sale.orderId, sale.captureId]),
      callLog: entry.workspace.callLog,
      agentKeyId: entry.agentKeyId,
      now: this.now,
    }).then(() => log(`Demo run ${run.id}: ${run.status}${run.error ? ` (${run.error})` : ""}`));
    return run;
  }

  /**
   * Where a PayPal webhook about these objects belongs: a live demo workspace,
   * "drop" for a demo object whose workspace is gone, or null for real data.
   */
  routeWebhook(resourceIds: string[]): Workspace | "drop" | null {
    const ids = resourceIds.filter(Boolean);
    if (ids.length === 0) return null;
    for (const entry of this.entries.values()) {
      if (ids.some((id) => entry.resources.has(id))) return entry.workspace;
    }
    const placeholders = ids.map(() => "?").join(", ");
    const known = this.opts.realDb.prepare(`SELECT 1 FROM demo_resources WHERE id IN (${placeholders}) LIMIT 1`).get(...ids);
    return known ? "drop" : null;
  }

  /** Discards idle workspaces (never one with a run in progress). */
  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsedAt < cutoff && entry.run?.status !== "running") this.discard(key);
    }
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const key of [...this.entries.keys()]) this.discard(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private entry(sessionToken: string): Entry {
    const key = tokenHash(sessionToken);
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxWorkspaces) this.evictOne();
      const workspace = this.opts.open();
      const { key: agentKey, secret } = workspace.agentKeys.create(DEMO_AGENT_NAME, DEMO_SYSTEM, now);
      entry = { workspace, agentKey: secret, agentKeyId: agentKey.id, lastUsedAt: now, resources: new Set(), run: null };
      this.entries.set(key, entry);
      this.byAgentKey.set(tokenHash(secret), key);
    }
    entry.lastUsedAt = now;
    return entry;
  }

  private evictOne(): void {
    const idle = [...this.entries].filter(([, e]) => e.run?.status !== "running").sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (idle) this.discard(idle[0]);
    else throw new DemoError(503, "The demo is busy right now. Try again in a minute.");
  }

  private discard(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.byAgentKey.delete(tokenHash(entry.agentKey));
    entry.workspace.close();
  }

  private remember(entry: Entry, ids: string[]): void {
    const insert = this.opts.realDb.prepare(`INSERT OR IGNORE INTO demo_resources (id, created_at) VALUES (?, ?)`);
    for (const id of ids) {
      entry.resources.add(id);
      insert.run(id, this.now());
    }
  }
}
