import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AuditChain } from "../audit-chain.js";
import { AccountError, tokenHash } from "./accounts.js";

/** Who made an MCP call: an agent key, the legacy env token, or a local stdio agent. */
export interface AgentIdentity {
  keyId: string | null;
  name: string;
}

export const STDIO_AGENT: AgentIdentity = { keyId: null, name: "Local agent (stdio)" };
export const ENV_TOKEN_AGENT: AgentIdentity = { keyId: null, name: "HANDRAIL_AGENT_TOKEN" };

export interface AgentKey {
  id: string;
  name: string;
  /** The first characters of the key, so people can tell keys apart. */
  prefix: string;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

const KEY_PREFIX = "hr_agent_";
/** Don't rewrite last_used_at on every call. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * API keys agents use to reach /mcp. A key is shown once when created; only
 * its SHA-256 is stored. Creating and revoking keys is recorded in the audit chain.
 */
export class AgentKeyStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly chain = new AuditChain(db),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_keys (
        id           TEXT    PRIMARY KEY,
        name         TEXT    NOT NULL,
        prefix       TEXT    NOT NULL,
        hash         TEXT    NOT NULL UNIQUE,
        created_by   TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        revoked_at   INTEGER,
        last_used_at INTEGER
      );
    `);
  }

  create(name: string, by: { id: string; name: string }, now: number): { key: AgentKey; secret: string } {
    const label = typeof name === "string" ? name.trim().slice(0, 80) : "";
    if (!label) throw new AccountError("Give the key a name, e.g. the agent that will use it.", 400);
    const secret = KEY_PREFIX + randomBytes(32).toString("base64url");
    const id = `key_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const prefix = secret.slice(0, KEY_PREFIX.length + 6);
    this.chain.record(now, () => {
      this.db
        .prepare(`INSERT INTO agent_keys (id, name, prefix, hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, label, prefix, tokenHash(secret), by.id, now);
      return { value: undefined, entries: [{ kind: "agent_key.created" as const, ref: `agent_key:${id}`, data: { name: label, prefix, by } }] };
    });
    return { key: this.get(id)!, secret };
  }

  get(id: string): AgentKey | null {
    const row = this.db.prepare(`SELECT * FROM agent_keys WHERE id = ?`).get(id) as KeyRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(): AgentKey[] {
    return (this.db.prepare(`SELECT * FROM agent_keys ORDER BY created_at DESC`).all() as unknown as KeyRow[]).map(fromRow);
  }

  revoke(id: string, by: { id: string; name: string }, now: number): AgentKey {
    this.chain.record(now, () => {
      const changed = this.db.prepare(`UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, id).changes;
      if (!changed) throw new AccountError("Key not found or already revoked.", 404);
      return { value: undefined, entries: [{ kind: "agent_key.revoked" as const, ref: `agent_key:${id}`, data: { by } }] };
    });
    return this.get(id)!;
  }

  /** The agent a key belongs to, or null if the key is unknown or revoked. */
  authenticate(secret: string, now: number): AgentIdentity | null {
    if (!secret.startsWith(KEY_PREFIX)) return null;
    const row = this.db.prepare(`SELECT * FROM agent_keys WHERE hash = ?`).get(tokenHash(secret)) as KeyRow | undefined;
    if (!row || row.revoked_at !== null) return null;
    if (!row.last_used_at || now - row.last_used_at > TOUCH_INTERVAL_MS) {
      this.db.prepare(`UPDATE agent_keys SET last_used_at = ? WHERE id = ?`).run(now, row.id);
    }
    return { keyId: row.id, name: row.name };
  }
}

function fromRow(row: KeyRow): AgentKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}
