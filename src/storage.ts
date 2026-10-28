import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Whether Handrail's data survives a redeploy.
 *
 * - local:      not on Render; the files are on this machine's disk.
 * - persistent: on Render, and the database and policy are on a mounted disk
 *               (a different filesystem from the app's own directory).
 * - temporary:  on Render without a disk; accounts, the audit log, approvals and
 *               policy changes reset on every deploy or restart.
 * - partial:    on Render, one of the two is on a disk and the other isn't.
 */
export type StorageMode = "local" | "persistent" | "temporary" | "partial";

export interface StorageStatus {
  mode: StorageMode;
  db: { path: string; persistent: boolean };
  policy: { path: string; persistent: boolean };
}

export function storageStatus(
  dbPath: string,
  policyPath: string,
  env: Record<string, string | undefined>,
  appDir: string = process.cwd(),
): StorageStatus {
  const onRender = !!(env.RENDER || env.RENDER_SERVICE_ID);
  const db = resolve(dbPath);
  const policy = resolve(policyPath);
  if (!onRender) return { mode: "local", db: { path: db, persistent: true }, policy: { path: policy, persistent: true } };

  const appDevice = device(appDir);
  const onDisk = (path: string) => {
    const dev = device(dirname(path));
    return dev !== null && appDevice !== null && dev !== appDevice;
  };
  const dbOnDisk = onDisk(db);
  const policyOnDisk = onDisk(policy);
  const mode: StorageMode = dbOnDisk && policyOnDisk ? "persistent" : !dbOnDisk && !policyOnDisk ? "temporary" : "partial";
  return { mode, db: { path: db, persistent: dbOnDisk }, policy: { path: policy, persistent: policyOnDisk } };
}

function device(path: string): number | null {
  try {
    return statSync(path).dev;
  } catch {
    return null;
  }
}

export function describeStorage(s: StorageStatus): string {
  switch (s.mode) {
    case "local":
      return `local disk (${s.db.path}, ${s.policy.path})`;
    case "persistent":
      return `persistent disk (${s.db.path}, ${s.policy.path})`;
    case "temporary":
      return "temporary: accounts, the audit log, approvals and policy changes reset on every deploy or restart (no Render disk)";
    case "partial":
      return `partly temporary: ${s.db.persistent ? "the policy" : "the database"} is not on a Render disk and resets on every deploy or restart`;
  }
}
