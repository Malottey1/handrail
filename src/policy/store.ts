import { renameSync, statSync, writeFileSync } from "node:fs";
import { AuditChain, sha256 } from "../audit-chain.js";
import { canonicalJson } from "../idempotency.js";
import { log } from "../log.js";
import { loadPolicyFile, parsePolicy } from "./load.js";
import type { Policy } from "./types.js";

export const policyHash = (policy: Policy) => sha256(canonicalJson(policy));

export class PolicyConflictError extends Error {}

/**
 * The policy in force. Changes are validated by the same parser as the file,
 * written back to the policy file atomically, and recorded in the audit log
 * with who made them and the plain-English request (if any) behind them.
 *
 * If the file changes on disk (an edit by hand, or another Handrail process
 * saving a change from the dashboard), the next get() reloads it. An invalid
 * file is ignored and the previous policy stays in force.
 *
 * With no path (demo workspaces), the policy lives in memory only.
 */
export class PolicyStore {
  private current: Policy;
  private mtimeMs: number;

  constructor(
    private readonly path: string | null,
    private readonly audit: AuditChain,
    initial: Policy,
  ) {
    this.current = initial;
    this.mtimeMs = this.fileMtime();
  }

  get(): Policy {
    if (this.path === null) return this.current;
    const mtimeMs = this.fileMtime();
    if (mtimeMs !== this.mtimeMs) {
      this.mtimeMs = mtimeMs;
      try {
        const next = loadPolicyFile(this.path);
        if (policyHash(next) !== policyHash(this.current)) {
          this.current = next;
          log(`Reloaded policy ${this.path} (${next.rules.length} rules)`);
          this.recordLoaded(Date.now());
        }
      } catch (err) {
        log(`Ignoring changed ${this.path}; keeping the previous policy. ${(err as Error).message}`);
      }
    }
    return this.current;
  }

  private fileMtime(): number {
    if (this.path === null) return 0;
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }

  hash(): string {
    return policyHash(this.get());
  }

  /** Records the policy in force at startup, if it isn't the one last recorded (e.g. the file was edited). */
  recordLoaded(now: number): void {
    const last = this.audit.list(1, "policy")[0];
    const lastHash = last ? (JSON.parse(last.data_json) as { hash?: string }).hash : undefined;
    if (lastHash === this.hash()) return;
    this.audit.append({ kind: "policy.loaded", ref: "policy", data: { path: this.path, hash: this.hash(), policy: this.current } }, now);
  }

  /**
   * Replaces the policy. `baseHash` is the hash the editor started from, so
   * two people editing at once can't silently overwrite each other.
   */
  /** `byId` is the signed-in user's id, when the change came from the dashboard. */
  replace(input: unknown, opts: { by: string; byId?: string; baseHash: string; source: string | null; now: number }): Policy {
    if (opts.baseHash !== this.hash()) {
      throw new PolicyConflictError("The policy changed since you loaded it. Reload and try again.");
    }
    const next = parsePolicy(input);
    const before = new Map(this.current.rules.map((r) => [r.id, canonicalJson(r)]));
    const after = new Map(next.rules.map((r) => [r.id, canonicalJson(r)]));

    if (this.path !== null) {
      const tmp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
      renameSync(tmp, this.path);
      this.mtimeMs = this.fileMtime();
    }

    const previousHash = policyHash(this.current);
    this.current = next;
    this.audit.append(
      {
        kind: "policy.changed",
        ref: "policy",
        data: {
          by: opts.by,
          ...(opts.byId ? { byId: opts.byId } : {}),
          source: opts.source,
          added: [...after.keys()].filter((id) => !before.has(id)),
          removed: [...before.keys()].filter((id) => !after.has(id)),
          changed: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)),
          previousHash,
          hash: this.hash(),
          policy: next,
        },
      },
      opts.now,
    );
    return next;
  }
}
