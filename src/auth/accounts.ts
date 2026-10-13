import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AuditChain } from "../audit-chain.js";

/**
 * admin     manage policies, users, invites and agent keys (and everything below)
 * approver  approve or reject held calls (and everything below)
 * viewer    read-only
 */
export type Role = "admin" | "approver" | "viewer";
export const ROLES: Role[] = ["admin", "approver", "viewer"];
const RANK: Record<Role, number> = { viewer: 0, approver: 1, admin: 2 };

export function hasRole(role: Role, needed: Role): boolean {
  return RANK[role] >= RANK[needed];
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** The shared demo account for judges. Can't change its own profile or password. */
  isDemo: boolean;
  createdAt: number;
  disabledAt: number | null;
  /** Wants an email when a call is held (approvers and admins only get them). On by default. */
  emailAlerts: boolean;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  is_demo: number;
  created_at: number;
  updated_at: number;
  disabled_at: number | null;
  email_alerts: number;
}

interface InviteRow {
  id: string;
  token_hash: string;
  email: string;
  role: Role;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEMO_EMAIL = "demo@handrail.example";

/** Session ids, invite tokens and agent keys are random 256-bit values, so a plain SHA-256 is the right lookup hash. */
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;

export function normalizeEmail(email: unknown): string {
  const value = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new AccountError("Enter a valid email address.", 400);
  return value;
}

export function normalizeName(name: unknown): string {
  const value = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!value || value.length > 100) throw new AccountError("Enter a name (up to 100 characters).", 400);
  return value;
}

/** A user's public reference in the audit log. Never includes the password hash or email changes' secrets. */
const actor = (u: { id: string; name: string }) => ({ id: u.id, name: u.name });

/**
 * Users, invites and sessions. Changes to who can do what (sign-ups, role
 * changes, invites) are recorded in the audit chain.
 */
export class AccountStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly chain = new AuditChain(db),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT    PRIMARY KEY,
        email         TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL,
        role          TEXT    NOT NULL,
        password_hash TEXT    NOT NULL,
        is_demo       INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        disabled_at   INTEGER
      );
      CREATE TABLE IF NOT EXISTS invites (
        id         TEXT    PRIMARY KEY,
        token_hash TEXT    NOT NULL UNIQUE,
        email      TEXT    NOT NULL,
        role       TEXT    NOT NULL,
        created_by TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER,
        used_by    TEXT,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash    TEXT    PRIMARY KEY,
        user_id    TEXT    NOT NULL,
        csrf       TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
    `);
    const columns = new Set((db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has("email_alerts")) db.exec(`ALTER TABLE users ADD COLUMN email_alerts INTEGER NOT NULL DEFAULT 1`);
  }

  /** Whether this user gets an email when a call is held. The demo account never does. */
  setEmailAlerts(id: string, on: boolean, now: number): User {
    const user = this.requireUser(id);
    if (user.isDemo) throw new AccountError("The demo account never gets emails; alerts are shown as previews instead.", 403);
    return this.chain.record(now, () => {
      this.db.prepare(`UPDATE users SET email_alerts = ?, updated_at = ? WHERE id = ?`).run(on ? 1 : 0, now, id);
      const data = { user: actor(user), by: actor(user), changes: { emailAlerts: on } };
      return { value: this.get(id)!, entries: [{ kind: "user.updated" as const, ref: `user:${id}`, data }] };
    });
  }

  /** Who gets held-call emails: active approvers and admins who left email alerts on. Never the demo account. */
  alertRecipients(): Array<{ id: string; name: string; email: string }> {
    return this.db
      .prepare(
        `SELECT id, name, email FROM users
         WHERE role IN ('approver', 'admin') AND disabled_at IS NULL AND is_demo = 0 AND email_alerts = 1
         ORDER BY created_at`,
      )
      .all() as Array<{ id: string; name: string; email: string }>;
  }

  // ---- users

  /** Real (non-demo) accounts. Zero means the next sign-up becomes the admin. */
  countUsers(): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM users WHERE is_demo = 0`).get() as { n: number }).n;
  }

  get(id: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? fromUserRow(row) : null;
  }

  /** The user and stored hash for a login attempt. */
  forLogin(email: string): { user: User; passwordHash: string } | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow | undefined;
    return row ? { user: fromUserRow(row), passwordHash: row.password_hash } : null;
  }

  passwordHash(id: string): string | null {
    return (this.db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(id) as { password_hash: string } | undefined)?.password_hash ?? null;
  }

  list(): User[] {
    return (this.db.prepare(`SELECT * FROM users ORDER BY created_at`).all() as unknown as UserRow[]).map(fromUserRow);
  }

  /**
   * The first real account becomes the admin; after that an unused, unexpired
   * invite is required, and it sets the role. Checked inside the transaction,
   * so two simultaneous first sign-ups can't both become admin.
   */
  signUp(input: { email: string; name: string; passwordHash: string; inviteToken: string | null }, now: number): User {
    return this.chain.record(now, () => {
      let role: Role = "admin";
      let invite: InviteRow | null = null;
      if (this.countUsers() > 0) {
        if (!input.inviteToken) throw new AccountError("Handrail already has an admin. Ask them for an invite link.", 403);
        invite = this.usableInvite(input.inviteToken, now);
        if (!invite) throw new AccountError("This invite link is invalid, used or expired.", 403);
        if (invite.email !== input.email) throw new AccountError(`This invite is for ${invite.email}.`, 403);
        role = invite.role;
      }
      if (this.db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(input.email)) {
        throw new AccountError("An account with this email already exists.", 409);
      }
      const id = newId("usr");
      this.db
        .prepare(
          `INSERT INTO users (id, email, name, role, password_hash, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(id, input.email, input.name, role, input.passwordHash, now, now);
      if (invite) this.db.prepare(`UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?`).run(now, id, invite.id);
      const data = { user: { id, name: input.name, email: input.email }, role, via: invite ? `invite:${invite.id}` : "first sign-up" };
      return { value: this.get(id)!, entries: [{ kind: "user.created" as const, ref: `user:${id}`, data }] };
    });
  }

  /** Creates the shared demo approver if it doesn't exist. Its password is random and never used. */
  ensureDemoUser(passwordHash: string, now: number): User {
    const existing = this.db.prepare(`SELECT * FROM users WHERE is_demo = 1`).get() as UserRow | undefined;
    if (existing) return fromUserRow(existing);
    return this.chain.record(now, () => {
      const id = newId("usr");
      this.db
        .prepare(
          `INSERT INTO users (id, email, name, role, password_hash, is_demo, created_at, updated_at) VALUES (?, ?, ?, 'approver', ?, 1, ?, ?)`,
        )
        .run(id, DEMO_EMAIL, "Demo Approver", passwordHash, now, now);
      const data = { user: { id, name: "Demo Approver", email: DEMO_EMAIL }, role: "approver", via: "demo account" };
      return { value: this.get(id)!, entries: [{ kind: "user.created" as const, ref: `user:${id}`, data }] };
    });
  }

  demoUser(): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE is_demo = 1 AND disabled_at IS NULL`).get() as UserRow | undefined;
    return row ? fromUserRow(row) : null;
  }

  updateProfile(id: string, changes: { name: string; email: string }, now: number): User {
    const user = this.requireUser(id);
    if (user.isDemo) throw new AccountError("The demo account's profile can't be changed.", 403);
    return this.chain.record(now, () => {
      const taken = this.db.prepare(`SELECT 1 FROM users WHERE email = ? AND id != ?`).get(changes.email, id);
      if (taken) throw new AccountError("Another account uses this email.", 409);
      this.db.prepare(`UPDATE users SET name = ?, email = ?, updated_at = ? WHERE id = ?`).run(changes.name, changes.email, now, id);
      const data = { user: actor({ id, name: changes.name }), by: actor(user), changes: { name: changes.name, email: changes.email } };
      return { value: this.get(id)!, entries: [{ kind: "user.updated" as const, ref: `user:${id}`, data }] };
    });
  }

  /** Changes the password and signs out every other session. */
  setPassword(id: string, passwordHash: string, keepSessionToken: string | null, now: number): void {
    const user = this.requireUser(id);
    if (user.isDemo) throw new AccountError("The demo account's password can't be changed.", 403);
    this.chain.record(now, () => {
      this.db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(passwordHash, now, id);
      this.db
        .prepare(`DELETE FROM sessions WHERE user_id = ? AND id_hash != ?`)
        .run(id, keepSessionToken ? tokenHash(keepSessionToken) : "");
      const data = { user: actor(user), by: actor(user), changes: { password: "changed" } };
      return { value: undefined, entries: [{ kind: "user.updated" as const, ref: `user:${id}`, data }] };
    });
  }

  /** Admin changes to another user's role or access. An admin can't lock everyone out. */
  setAccess(id: string, changes: { role?: Role; disabled?: boolean }, by: { id: string; name: string }, now: number): User {
    const user = this.requireUser(id);
    if (id === by.id) throw new AccountError("You can't change your own role or access.", 400);
    return this.chain.record(now, () => {
      const role = changes.role ?? user.role;
      const disabled = changes.disabled ?? user.disabledAt !== null;
      if (user.role === "admin" && (role !== "admin" || disabled)) {
        const admins = (
          this.db.prepare(`SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND is_demo = 0`).get() as { n: number }
        ).n;
        if (admins <= 1) throw new AccountError("Handrail needs at least one active admin.", 400);
      }
      if (user.isDemo && role === "admin") throw new AccountError("The demo account can't be an admin.", 400);
      this.db
        .prepare(`UPDATE users SET role = ?, disabled_at = ?, updated_at = ? WHERE id = ?`)
        .run(role, disabled ? (user.disabledAt ?? now) : null, now, id);
      if (disabled) this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
      const data = { user: actor(user), by, changes: { role, disabled } };
      return { value: this.get(id)!, entries: [{ kind: "user.updated" as const, ref: `user:${id}`, data }] };
    });
  }

  private requireUser(id: string): User {
    const user = this.get(id);
    if (!user) throw new AccountError("User not found.", 404);
    return user;
  }

  // ---- invites

  /** Returns the invite and its token. The token is shown once; only its hash is stored. */
  createInvite(email: string, role: Role, by: { id: string; name: string }, now: number): { invite: Invite; token: string } {
    if (this.db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(email)) {
      throw new AccountError("An account with this email already exists.", 409);
    }
    const token = newToken();
    const id = newId("inv");
    this.chain.record(now, () => {
      this.db
        .prepare(`INSERT INTO invites (id, token_hash, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tokenHash(token), email, role, by.id, now, now + INVITE_TTL_MS);
      return { value: undefined, entries: [{ kind: "invite.created" as const, ref: `invite:${id}`, data: { email, role, by } }] };
    });
    return { invite: this.listInvites().find((i) => i.id === id)!, token };
  }

  listInvites(): Invite[] {
    return (this.db.prepare(`SELECT * FROM invites ORDER BY created_at DESC`).all() as unknown as InviteRow[]).map(fromInviteRow);
  }

  revokeInvite(id: string, by: { id: string; name: string }, now: number): void {
    this.chain.record(now, () => {
      const changed = this.db.prepare(`UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`).run(now, id).changes;
      if (!changed) throw new AccountError("Invite not found, or already used or revoked.", 404);
      return { value: undefined, entries: [{ kind: "invite.revoked" as const, ref: `invite:${id}`, data: { by } }] };
    });
  }

  /** What an invite link is for, so the sign-up form can show it. */
  inviteInfo(token: string, now: number): { email: string; role: Role } | null {
    const row = this.usableInvite(token, now);
    return row ? { email: row.email, role: row.role } : null;
  }

  private usableInvite(token: string, now: number): InviteRow | null {
    const row = this.db.prepare(`SELECT * FROM invites WHERE token_hash = ?`).get(tokenHash(token)) as InviteRow | undefined;
    return row && row.used_at === null && row.revoked_at === null && row.expires_at > now ? row : null;
  }

  // ---- sessions

  createSession(userId: string, now: number): { token: string; csrf: string; expiresAt: number } {
    const token = newToken();
    const csrf = newToken();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now);
    this.db.prepare(`INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`).run(tokenHash(token), userId, csrf, now, expiresAt);
    return { token, csrf, expiresAt };
  }

  /** The signed-in user for a session cookie, or null if it's unknown, expired or the user is disabled. */
  session(token: string, now: number): { user: User; csrf: string } | null {
    const row = this.db.prepare(`SELECT user_id, csrf, expires_at FROM sessions WHERE id_hash = ?`).get(tokenHash(token)) as
      | { user_id: string; csrf: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at <= now) return null;
    const user = this.get(row.user_id);
    if (!user || user.disabledAt !== null) return null;
    return { user, csrf: row.csrf };
  }

  deleteSession(token: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id_hash = ?`).run(tokenHash(token));
  }
}

function fromUserRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isDemo: row.is_demo === 1,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    emailAlerts: row.email_alerts !== 0,
  };
}

function fromInviteRow(row: InviteRow): Invite {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
  };
}
