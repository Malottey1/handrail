import { Check, CircleCheck, CircleMinus, KeyRound, Mail, Plus, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { api, ApiError, type AgentKey, type Invite, type Role, type Session, type User } from "../api";
import { CopyButton, Empty, Mono, PageHeader, Pill, usePoll } from "../components";
import { FilterSelect, SearchField, SidePanel, Facts } from "../explore";
import { countdown, timeAgo } from "../format";

const ROLES: Role[] = ["admin", "approver", "viewer"];
const ROLE_LABEL: Record<Role, string> = { admin: "Admin", approver: "Approver", viewer: "Viewer" };
const ROLE_TONE: Record<Role, string> = { admin: "good", approver: "info", viewer: "muted" };
const ROLE_HELP: Record<Role, string> = {
  admin: "Policies, people, agent keys and settings",
  approver: "Approve or reject held calls",
  viewer: "See everything, change nothing",
};

/** What each role can do, as the server enforces it (createAdminApi). */
const PERMISSIONS: Array<[string, Role]> = [
  ["See approvals, activity, webhooks, the audit log, policy and setup", "viewer"],
  ["Approve or reject held calls", "approver"],
  ["Get email alerts about held calls", "approver"],
  ["Change the policy (rules, defaults, how long calls are held)", "admin"],
  ["Invite people, change roles, disable accounts", "admin"],
  ["Create and revoke agent keys", "admin"],
  ["Confirm setup items, send test calls, set the Slack webhook", "admin"],
];
const RANK: Record<Role, number> = { viewer: 0, approver: 1, admin: 2 };

const message = (err: unknown) => (err instanceof ApiError ? err.message : String(err));
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

type Tab = "members" | "keys" | "roles";
type Panel = { kind: "invite" } | { kind: "key" } | null;

/** Admin only (the server enforces it too): people, invites and agent keys. */
export function TeamView({ session, title, subtitle }: { session: Session; title: string; subtitle: string }) {
  const users = usePoll(() => api<User[]>(session, "/users"), 10000);
  const invites = usePoll(() => api<Invite[]>(session, "/invites"), 15000);
  const keys = usePoll(() => api<AgentKey[]>(session, "/agent-keys"), 10000);
  const [tab, setTab] = useState<Tab>("members");
  const [panel, setPanel] = useState<Panel>(null);
  const close = useCallback(() => setPanel(null), []);
  const now = Date.now();

  const people = users.data ?? [];
  const open = (invites.data ?? []).filter((i) => !i.usedAt && !i.revokedAt && i.expiresAt > now);
  const allKeys = keys.data ?? [];
  const activeKeys = allKeys.filter((k) => !k.revokedAt);
  const nameOf = (id: string) => (id === "admin-script" ? "Admin script" : people.find((u) => u.id === id)?.name ?? "Someone");

  return (
    <div className={`explore ${panel ? "has-panel" : ""}`}>
      <div className="explore-main">
        <PageHeader title={title} subtitle={subtitle} />

        <div className="metrics metrics-3">
          <div className="metric metric-good">
            <span className="metric-icon" aria-hidden="true">
              <Users size={20} />
            </span>
            <span className="metric-body">
              <span className="metric-value num">{users.data ? people.length : "–"}</span>
              <span className="metric-label">Team members</span>
              <span className="trend trend-neutral">
                {people.filter((u) => !u.disabled).length} active · {open.length} invite{open.length === 1 ? "" : "s"} pending
              </span>
            </span>
          </div>
          <div className="metric metric-good">
            <span className="metric-icon" aria-hidden="true">
              <KeyRound size={20} />
            </span>
            <span className="metric-body">
              <span className="metric-value num">{keys.data ? activeKeys.length : "–"}</span>
              <span className="metric-label">Active agent keys</span>
              <span className="trend trend-neutral">{allKeys.length - activeKeys.length} revoked</span>
            </span>
          </div>
          <div className="metric metric-neutral">
            <span className="metric-icon" aria-hidden="true">
              <ShieldCheck size={20} />
            </span>
            <span className="metric-body">
              <span className="metric-value num">3</span>
              <span className="metric-label">Roles</span>
              <span className="trend trend-neutral">Admin, Approver, Viewer</span>
            </span>
          </div>
        </div>

        <div className="tab-bar">
          <nav className="seg-tabs" role="tablist">
            {(
              [
                ["members", "Team members", people.length + open.length],
                ["keys", "Agent keys", allKeys.length],
                ["roles", "Roles", null],
              ] as Array<[Tab, string, number | null]>
            ).map(([id, label, n]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={`seg-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                {label}
                {n !== null && <span className="count-badge">{n}</span>}
              </button>
            ))}
          </nav>
          {tab === "members" && (
            <button type="button" className="btn btn-dark btn-lg" onClick={() => setPanel({ kind: "invite" })}>
              <Plus size={18} aria-hidden="true" />
              Invite member
            </button>
          )}
          {tab === "keys" && (
            <button type="button" className="btn btn-dark btn-lg" onClick={() => setPanel({ kind: "key" })}>
              <Plus size={18} aria-hidden="true" />
              Create agent key
            </button>
          )}
        </div>

        {tab === "members" && (
          <Members
            session={session}
            users={people}
            invites={open}
            loading={!users.data}
            error={users.error?.message ?? null}
            onChange={() => {
              users.refresh();
              invites.refresh();
            }}
          />
        )}
        {tab === "keys" && <Keys session={session} keys={allKeys} loading={!keys.data} nameOf={nameOf} onChange={keys.refresh} />}
        {tab === "roles" && <Roles />}
      </div>

      {panel?.kind === "invite" && <InvitePanel session={session} onClose={close} onCreated={invites.refresh} />}
      {panel?.kind === "key" && <KeyPanel session={session} onClose={close} onCreated={keys.refresh} />}
    </div>
  );
}

function Members({
  session,
  users,
  invites,
  loading,
  error: loadError,
  onChange,
}: {
  session: Session;
  users: User[];
  invites: Invite[];
  loading: boolean;
  error: string | null;
  onChange: () => void;
}) {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  const q = search.trim().toLowerCase();
  const match = (name: string, email: string, r: Role) => (!role || r === role) && (!q || name.toLowerCase().includes(q) || email.toLowerCase().includes(q));

  async function change(user: User, changes: { role?: Role; disabled?: boolean }) {
    if (changes.disabled && !window.confirm(`Disable ${user.name}? They're signed out everywhere and can't sign in until enabled again.`)) return;
    setError(null);
    try {
      await api(session, `/users/${user.id}`, { method: "PATCH", body: changes });
    } catch (err) {
      setError(message(err));
    }
    onChange();
  }

  async function revoke(invite: Invite) {
    if (!window.confirm(`Revoke the invite for ${invite.email}? The link stops working.`)) return;
    await api(session, `/invites/${invite.id}`, { method: "DELETE" }).catch((err) => setError(message(err)));
    onChange();
  }

  return (
    <section className="card table-card">
      <div className="table-tools">
        <SearchField value={search} onChange={setSearch} placeholder="Search team members…" />
        <FilterSelect label="Role" value={role} options={[{ value: "", label: "All roles" }, ...ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))]} onChange={setRole} />
      </div>
      {(error ?? loadError) && <p className="error pad-x">{error ?? loadError}</p>}
      <div className="table-wrap">
        <table className="table team-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {users
              .filter((u) => match(u.name, u.email, u.role))
              .map((u) => {
                const self = u.id === session.user.id;
                return (
                  <tr key={u.id}>
                    <td>
                      <span className="person">
                        <span className="avatar avatar-sm" aria-hidden="true">
                          {initials(u.name)}
                        </span>
                        <span className="person-name">{u.name}</span>
                        {self && <span className="tag">You</span>}
                        {u.isDemo && <span className="tag">Demo</span>}
                      </span>
                    </td>
                    <td className="cell-muted">{u.email}</td>
                    <td>
                      {self ? (
                        <Pill tone={ROLE_TONE[u.role]}>{ROLE_LABEL[u.role]}</Pill>
                      ) : (
                        <span className="select-pill select-inline">
                          <select value={u.role} aria-label={`Role for ${u.name}`} onChange={(e) => void change(u, { role: e.target.value as Role })}>
                            {ROLES.filter((r) => !u.isDemo || r !== "admin").map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABEL[r]}
                              </option>
                            ))}
                          </select>
                        </span>
                      )}
                    </td>
                    <td>{u.disabled ? <Pill tone="muted">Disabled</Pill> : <Pill tone="good">Active</Pill>}</td>
                    <td className="cell-muted">{timeAgo(u.createdAt, now)}</td>
                    <td className="actions">
                      {!self && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void change(u, { disabled: !u.disabled })}>
                          {u.disabled ? "Enable" : "Disable"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            {invites
              .filter((i) => match("", i.email, i.role))
              .map((i) => (
                <tr key={i.id}>
                  <td>
                    <span className="person">
                      <span className="avatar avatar-sm avatar-pending" aria-hidden="true">
                        <Mail size={15} />
                      </span>
                      <span className="person-name muted">Invited</span>
                    </span>
                  </td>
                  <td className="cell-muted">{i.email}</td>
                  <td>
                    <Pill tone={ROLE_TONE[i.role]}>{ROLE_LABEL[i.role]}</Pill>
                  </td>
                  <td>
                    <Pill tone="warn">Pending</Pill>
                  </td>
                  <td className="cell-muted">Link {countdown(new Date(i.expiresAt).toISOString(), now)}</td>
                  <td className="actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revoke(i)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {loading && <p className="muted pad-x">Loading…</p>}
      </div>
      <p className="fine pad-x">An admin can't change their own role, and the last active admin can't be demoted or disabled. Every change is in the audit log.</p>
    </section>
  );
}

function Keys({ session, keys, loading, nameOf, onChange }: { session: Session; keys: AgentKey[]; loading: boolean; nameOf: (id: string) => string; onChange: () => void }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  const q = search.trim().toLowerCase();
  const shown = keys.filter(
    (k) => (!status || (status === "active") === !k.revokedAt) && (!q || k.name.toLowerCase().includes(q) || k.prefix.toLowerCase().includes(q)),
  );

  async function revoke(key: AgentKey) {
    if (!window.confirm(`Revoke "${key.name}"? Agents using it are refused from now on. This can't be undone.`)) return;
    await api(session, `/agent-keys/${key.id}`, { method: "DELETE" }).catch((err) => setError(message(err)));
    onChange();
  }

  return (
    <section className="card table-card">
      <div className="table-tools">
        <SearchField value={search} onChange={setSearch} placeholder="Search keys…" />
        <FilterSelect
          label="Status"
          value={status}
          options={[
            { value: "", label: "All statuses" },
            { value: "active", label: "Active" },
            { value: "revoked", label: "Revoked" },
          ]}
          onChange={setStatus}
        />
      </div>
      {error && <p className="error pad-x">{error}</p>}
      {!loading && keys.length === 0 ? (
        <Empty title="No agent keys yet">Agents connect to /mcp with a key. Local agents that start Handrail over stdio don't need one.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table team-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created by</th>
                <th>Last used</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((k) => (
                <tr key={k.id}>
                  <td>
                    <span className="person">
                      <span className="key-icon" aria-hidden="true">
                        <KeyRound size={15} />
                      </span>
                      <span>
                        <span className="person-name">{k.name}</span>
                        <span className="person-sub">Created {timeAgo(new Date(k.createdAt).toISOString(), now)}</span>
                      </span>
                    </span>
                  </td>
                  <td>
                    <Mono>{k.prefix}…</Mono>
                  </td>
                  <td className="cell-muted">{nameOf(k.createdBy)}</td>
                  <td className="cell-muted">{k.lastUsedAt ? timeAgo(new Date(k.lastUsedAt).toISOString(), now) : "Never"}</td>
                  <td>{k.revokedAt ? <Pill tone="bad">Revoked</Pill> : <Pill tone="good">Active</Pill>}</td>
                  <td className="actions">
                    {!k.revokedAt && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revoke(k)}>
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
      <p className="fine pad-x">
        Agents connect to <Mono>{location.origin}/mcp</Mono> with <Mono>Authorization: Bearer &lt;key&gt;</Mono>. Handrail keeps only a hash of each key, so
        a key is shown once, when it's created.
      </p>
    </section>
  );
}

function Roles() {
  return (
    <div className="role-cards">
      {(["admin", "approver", "viewer"] as Role[]).map((r) => (
        <section key={r} className="card role-card">
          <header>
            <Pill tone={ROLE_TONE[r]}>{ROLE_LABEL[r]}</Pill>
            <p>{ROLE_HELP[r]}</p>
          </header>
          <ul className="perm-list">
            {PERMISSIONS.map(([text, needs]) => {
              const ok = RANK[r] >= RANK[needs];
              return (
                <li key={text} className={ok ? "ok" : "no"}>
                  {ok ? <CircleCheck size={17} aria-label="Can" /> : <CircleMinus size={17} aria-label="Can't" />}
                  {text}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="fine role-foot">Roles are checked by the server on every request, not just hidden in the dashboard. The first person to sign up is the admin; everyone else needs an invite.</p>
    </div>
  );
}

function InvitePanel({ session, onClose, onCreated }: { session: Session; onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("approver");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; role: Role; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ invite: Invite; link: string }>(session, "/invites", { method: "POST", body: { email, role } });
      setCreated({ email: res.invite.email, role: res.invite.role, url: new URL(res.link, location.origin).toString() });
      onCreated();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel
      title={created ? "Invite link created" : "Invite member"}
      subtitle={created ? "Copy the link now. It won't be shown again." : "They'll create their own password from the link."}
      tabs={[]}
      tab=""
      onTab={() => {}}
      onClose={onClose}
    >
      {created ? (
        <>
          <OnceBox title="Invite link created" text={`It works once, for ${created.email}, for 7 days.`} value={created.url} />
          <Facts
            rows={[
              ["Email", created.email],
              ["Role", <Pill key="r" tone={ROLE_TONE[created.role]}>{ROLE_LABEL[created.role]}</Pill>],
              ["Expires", "In 7 days"],
            ]}
          />
          <p className="panel-note">Send it to them yourself; Handrail doesn't email invites.</p>
          <button type="button" className="btn btn-dark btn-lg panel-cta" onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <form className="panel-form" onSubmit={submit}>
          <label className="field">
            <span className="field-label">Email</span>
            <input className="input" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <fieldset className="role-pick">
            <legend className="field-label">Role</legend>
            {(["approver", "viewer", "admin"] as Role[]).map((r) => (
              <label key={r} className={`role-option ${role === r ? "selected" : ""}`}>
                <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
                <span>
                  <span className="role-option-title">{ROLE_LABEL[r]}</span>
                  <span className="role-option-text">{ROLE_HELP[r]}</span>
                </span>
                {role === r && <Check size={17} aria-hidden="true" />}
              </label>
            ))}
          </fieldset>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-dark btn-lg panel-cta" disabled={busy}>
            {busy ? "Creating…" : "Create invite link"}
          </button>
        </form>
      )}
    </SidePanel>
  );
}

function KeyPanel({ session, onClose, onCreated }: { session: Session; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ key: AgentKey; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setCreated(await api<{ key: AgentKey; secret: string }>(session, "/agent-keys", { method: "POST", body: { name } }));
      onCreated();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel
      title={created ? "New agent key" : "Create agent key"}
      subtitle={created ? "Copy your key now. It won't be shown again." : "One key per agent, so every call records which agent made it."}
      tabs={[]}
      tab=""
      onTab={() => {}}
      onClose={onClose}
    >
      {created ? (
        <>
          <OnceBox title="Agent key created" text="This key is shown only once. Copy it and store it in the agent's secret configuration." value={created.secret} />
          <h3 className="panel-h">Key details</h3>
          <Facts
            rows={[
              ["Name", created.key.name],
              ["Prefix", <Mono key="p">{created.key.prefix}…</Mono>],
              ["Environment", "PayPal sandbox"],
              ["Created by", session.user.name],
              ["Created", new Date(created.key.createdAt).toLocaleString()],
              ["Expires", "Never; revoke it when it's no longer needed"],
            ]}
          />
          <h3 className="panel-h">Use it</h3>
          <Facts
            rows={[
              ["MCP endpoint", <Mono key="m">{location.origin}/mcp</Mono>],
              ["Header", <Mono key="h">Authorization: Bearer &lt;key&gt;</Mono>],
            ]}
          />
          <div className="reason-box reason-warn">
            <p className="reason-title">
              <TriangleAlert size={16} aria-hidden="true" /> Keep this key secure
            </p>
            <ul className="tight-list">
              <li>Store it in the agent's secret environment, never in code.</li>
              <li>Don't share it or commit it to version control.</li>
              <li>If it's exposed, revoke it in Agent keys and create another.</li>
            </ul>
          </div>
          <button type="button" className="btn btn-dark btn-lg panel-cta" onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <form className="panel-form" onSubmit={submit}>
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input"
              placeholder="Which agent is this for? e.g. Support bot"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              autoFocus
            />
            <span className="field-hint">Shown in Activity and the audit log for every call this key makes.</span>
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-dark btn-lg panel-cta" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create key"}
          </button>
        </form>
      )}
    </SidePanel>
  );
}

/** A value shown exactly once (a key or invite link), with a copy button. Closing the panel discards it. */
function OnceBox({ title, text, value }: { title: string; text: string; value: string }) {
  return (
    <>
      <div className="reason-box reason-good once-head" role="status">
        <CircleCheck size={22} aria-hidden="true" />
        <div>
          <p className="reason-title">{title}</p>
          <p>{text}</p>
        </div>
      </div>
      <div className="copy-field">
        <span className="copy-field-label">{title.includes("key") ? "Key" : "Link"}</span>
        <div className="copy-field-row">
          <code>{value}</code>
          <CopyButton text={value} label="Copy" className="icon-btn icon-btn-plain copy-icon" />
        </div>
      </div>
    </>
  );
}
