import { useState, type FormEvent } from "react";
import { api, ApiError, type AgentKey, type Invite, type Role, type Session, type User } from "../api";
import { Empty, Mono, Pill, usePoll } from "../components";
import { countdown, timeAgo } from "../format";

const ROLE_HELP: Record<Role, string> = {
  admin: "Policies, people and agent keys",
  approver: "Approve or reject held calls",
  viewer: "Read-only",
};
const message = (err: unknown) => (err instanceof ApiError ? err.message : String(err));

/** Admin only (the server enforces it too): people, invites and agent keys. */
export function TeamView({ session }: { session: Session }) {
  return (
    <div className="team">
      <People session={session} />
      <Invites session={session} />
      <AgentKeys session={session} />
    </div>
  );
}

function People({ session }: { session: Session }) {
  const users = usePoll(() => api<User[]>(session, "/users"), 10000);
  const [error, setError] = useState<string | null>(null);

  async function change(user: User, changes: { role?: Role; disabled?: boolean }) {
    setError(null);
    try {
      await api(session, `/users/${user.id}`, { method: "PATCH", body: changes });
    } catch (err) {
      setError(message(err));
    }
    users.refresh();
  }

  return (
    <section className="card">
      <h2 className="section-title">People</h2>
      <p className="section-help">
        Admins manage policies, people and agent keys. Approvers approve or reject held calls. Viewers can see everything but change
        nothing.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => {
              const self = u.id === session.user.id;
              return (
                <tr key={u.id}>
                  <td>
                    {u.name}
                    {self && <span className="muted"> (you)</span>}
                    {u.isDemo && <span className="muted"> (demo)</span>}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <select
                      className="input input-sm"
                      value={u.role}
                      disabled={self}
                      aria-label={`Role for ${u.name}`}
                      onChange={(e) => void change(u, { role: e.target.value as Role })}
                    >
                      {(["admin", "approver", "viewer"] as Role[])
                        .filter((r) => !u.isDemo || r !== "admin")
                        .map((r) => (
                          <option key={r} value={r}>
                            {r[0]!.toUpperCase() + r.slice(1)}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>{u.disabled ? <Pill tone="muted">Disabled</Pill> : <Pill tone="good">Active</Pill>}</td>
                  <td className="actions">
                    {!self && (
                      <button className="btn btn-ghost" onClick={() => void change(u, { disabled: !u.disabled })}>
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Invites({ session }: { session: Session }) {
  const invites = usePoll(() => api<Invite[]>(session, "/invites"), 15000);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("approver");
  const [created, setCreated] = useState<{ email: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ invite: Invite; link: string }>(session, "/invites", { method: "POST", body: { email, role } });
      setCreated({ email: res.invite.email, url: new URL(res.link, location.origin).toString() });
      setEmail("");
      invites.refresh();
    } catch (err) {
      setError(message(err));
    }
  }

  async function revoke(id: string) {
    await api(session, `/invites/${id}`, { method: "DELETE" }).catch((err) => setError(message(err)));
    invites.refresh();
  }

  const open = (invites.data ?? []).filter((i) => !i.usedAt && !i.revokedAt && i.expiresAt > now);
  return (
    <section className="card">
      <h2 className="section-title">Invite someone</h2>
      <form className="inline-form" onSubmit={submit}>
        <input className="input" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email" />
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
          {(["approver", "viewer", "admin"] as Role[]).map((r) => (
            <option key={r} value={r}>
              {r[0]!.toUpperCase() + r.slice(1)}: {ROLE_HELP[r]}
            </option>
          ))}
        </select>
        <button className="btn btn-primary">Create invite link</button>
      </form>
      {error && <p className="error">{error}</p>}
      {created && (
        <SecretBox
          title={`Invite link for ${created.email}`}
          value={created.url}
          note="Send this link to them. It works once, for this email, for 7 days. It won't be shown again."
          onDone={() => setCreated(null)}
        />
      )}
      {open.length > 0 && (
        <ul className="plain-list">
          {open.map((i) => (
            <li key={i.id}>
              <span>
                {i.email} · <strong>{i.role}</strong> · {countdown(new Date(i.expiresAt).toISOString(), now)}
              </span>
              <button className="btn btn-ghost" onClick={() => void revoke(i.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentKeys({ session }: { session: Session }) {
  const keys = usePoll(() => api<AgentKey[]>(session, "/agent-keys"), 10000);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ key: AgentKey; secret: string }>(session, "/agent-keys", { method: "POST", body: { name } });
      setCreated({ name: res.key.name, secret: res.secret });
      setName("");
      keys.refresh();
    } catch (err) {
      setError(message(err));
    }
  }

  async function revoke(key: AgentKey) {
    if (!window.confirm(`Revoke "${key.name}"? Agents using it are refused from now on. This can't be undone.`)) return;
    await api(session, `/agent-keys/${key.id}`, { method: "DELETE" }).catch((err) => setError(message(err)));
    keys.refresh();
  }

  return (
    <section className="card">
      <h2 className="section-title">Agent keys</h2>
      <p className="section-help">
        Agents connect to <Mono>{location.origin}/mcp</Mono> with <Mono>Authorization: Bearer &lt;key&gt;</Mono>. Calls without a valid
        key are refused, and every call records which key made it.
      </p>
      <form className="inline-form" onSubmit={submit}>
        <input className="input" placeholder="Which agent is this for? e.g. Support bot" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} aria-label="Key name" />
        <button className="btn btn-primary">Create key</button>
      </form>
      {error && <p className="error">{error}</p>}
      {created && (
        <SecretBox
          title={`Key for ${created.name}`}
          value={created.secret}
          note="Copy it now and store it in the agent's configuration. Handrail keeps only a hash, so it can't show it again."
          onDone={() => setCreated(null)}
        />
      )}
      {keys.data?.length === 0 ? (
        <Empty title="No agent keys yet">Local agents that start Handrail over stdio don't need one.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data?.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td>
                    <Mono>{k.prefix}…</Mono>
                  </td>
                  <td>{timeAgo(new Date(k.createdAt).toISOString(), now)}</td>
                  <td>{k.lastUsedAt ? timeAgo(new Date(k.lastUsedAt).toISOString(), now) : "Never"}</td>
                  <td>{k.revokedAt ? <Pill tone="bad">Revoked</Pill> : <Pill tone="good">Active</Pill>}</td>
                  <td className="actions">
                    {!k.revokedAt && (
                      <button className="btn btn-ghost" onClick={() => void revoke(k)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A value shown exactly once (a key or invite link), with a copy button. */
function SecretBox({ title, value, note, onDone }: { title: string; value: string; note: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret" role="status">
      <p className="secret-title">{title}</p>
      <div className="secret-row">
        <input className="input mono-input" readOnly value={value} onFocus={(e) => e.target.select()} aria-label={title} />
        <button
          className="btn btn-secondary"
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="fine">{note}</p>
      <button className="btn btn-ghost" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
