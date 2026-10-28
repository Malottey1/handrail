import { CalendarDays, CircleUser, Lock, Mail, ShieldCheck, Bell, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, ApiError, can, type AlertSettings, type Session, type User } from "../api";
import { Mono, PageHeader, PasswordInput, Pill, usePoll } from "../components";

const message = (err: unknown) => (err instanceof ApiError ? err.message : String(err));
const ROLE_LABEL = { admin: "Admin", approver: "Approver", viewer: "Viewer" } as const;
const ROLE_TONE = { admin: "good", approver: "info", viewer: "muted" } as const;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

type Section = "profile" | "security" | "notifications";
const SECTIONS: Array<[Section, string, typeof Lock]> = [
  ["profile", "Profile", UserRound],
  ["security", "Security", Lock],
  ["notifications", "Notifications", Bell],
];

/** Your own profile, password and alerts; for admins, the team's alert settings. */
export function AccountView({
  session,
  onUserChange,
  title,
  subtitle,
}: {
  session: Session;
  onUserChange: (u: User) => void;
  title: string;
  subtitle: string;
}) {
  const { user } = session;
  const [section, setSection] = useState<Section>("profile");

  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      {!user.isDemo && (
        <nav className="seg-tabs account-tabs" role="tablist">
          {SECTIONS.map(([id, label, Icon]) => (
            <button key={id} type="button" role="tab" aria-selected={section === id} className={`seg-tab ${section === id ? "active" : ""}`} onClick={() => setSection(id)}>
              <Icon size={18} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
      )}
      <div className="account-layout">
        <div className="account-main">
          {user.isDemo ? (
            <section className="card account-card">
              <header className="account-card-head">
                <h2>Demo account</h2>
                <p>A shared approver account for trying Handrail on PayPal's sandbox.</p>
              </header>
              <p>
                You're signed in as <strong>{user.name}</strong>. Its name, email and password can't be changed, and it can't become an admin.
              </p>
              <p>
                Held-call alerts are never emailed from the demo. Each held call shows an <strong>alert preview</strong> instead: the email approvers
                would get, with a link back to the call.
              </p>
            </section>
          ) : (
            <>
              {section === "profile" && <Profile session={session} onUserChange={onUserChange} />}
              {section === "security" && <Security session={session} />}
              {section === "notifications" && (
                <>
                  <EmailAlerts session={session} onUserChange={onUserChange} />
                  {can(session, "admin") && <TeamAlerts session={session} />}
                </>
              )}
            </>
          )}
        </div>
        <aside className="account-side">
          <section className="card account-card">
            <header className="account-card-head">
              <h2>Account summary</h2>
            </header>
            <dl className="summary-list">
              <div>
                <dt>
                  <CircleUser size={17} aria-hidden="true" /> Name
                </dt>
                <dd>{user.name}</dd>
              </div>
              <div>
                <dt>
                  <Mail size={17} aria-hidden="true" /> Email
                </dt>
                <dd>{user.email}</dd>
              </div>
              <div>
                <dt>
                  <ShieldCheck size={17} aria-hidden="true" /> Role
                </dt>
                <dd>
                  <Pill tone={ROLE_TONE[user.role]}>{ROLE_LABEL[user.role]}</Pill>
                </dd>
              </div>
              <div>
                <dt>
                  <CalendarDays size={17} aria-hidden="true" /> Member since
                </dt>
                <dd>{new Date(user.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</dd>
              </div>
              <div>
                <dt>
                  <Bell size={17} aria-hidden="true" /> Email alerts
                </dt>
                <dd>{user.emailAlerts ? "On" : "Off"}</dd>
              </div>
            </dl>
          </section>
          <p className="fine account-foot">Your name is recorded with every approval and policy change you make. Only an admin can change roles.</p>
        </aside>
      </div>
    </>
  );
}

function Profile({ session, onUserChange }: { session: Session; onUserChange: (u: User) => void }) {
  const { user } = session;
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [state, setState] = useState<{ tone: string; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api<{ user: User }>(session, "/me", { method: "PATCH", body: { name, email } });
      onUserChange(res.user);
      setState({ tone: "good", text: "Saved." });
    } catch (err) {
      setState({ tone: "bad", text: message(err) });
    }
  }

  return (
    <section className="card account-card">
      <header className="account-card-head">
        <h2>Profile</h2>
        <p>Your name and the email you sign in with.</p>
      </header>
      <form className="profile-grid" onSubmit={save}>
        <div className="profile-avatar">
          <span className="avatar avatar-lg" aria-hidden="true">
            {initials(user.name)}
          </span>
        </div>
        <div className="profile-fields">
          <label className="field">
            <span className="field-label">Full name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />
          </label>
          <label className="field">
            <span className="field-label">Email address</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <label className="field">
            <span className="field-label">Role</span>
            <input className="input" value={ROLE_LABEL[user.role]} readOnly disabled />
          </label>
          <div className="profile-actions">
            {state && <p className={`outcome outcome-${state.tone}`}>{state.text}</p>}
            <button className="btn btn-dark btn-lg" disabled={name.trim() === user.name && email.trim().toLowerCase() === user.email}>
              Save changes
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

function Security({ session }: { session: Session }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [state, setState] = useState<{ tone: string; text: string } | null>(null);

  async function change(e: FormEvent) {
    e.preventDefault();
    try {
      await api(session, "/me/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      setCurrent("");
      setNext("");
      setState({ tone: "good", text: "Password changed. Other devices have been signed out." });
    } catch (err) {
      setState({ tone: "bad", text: message(err) });
    }
  }

  return (
    <section className="card account-card">
      <header className="account-card-head">
        <h2>Password</h2>
        <p>Changing it signs you out on every other device.</p>
      </header>
      <form className="security-form" onSubmit={change}>
        <label className="field">
          <span className="field-label">Current password</span>
          <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </label>
        <label className="field">
          <span className="field-label">New password</span>
          <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} autoComplete="new-password" />
          <span className="field-hint">At least 10 characters.</span>
        </label>
        {state && <p className={`outcome outcome-${state.tone}`}>{state.text}</p>}
        <div className="profile-actions">
          <button className="btn btn-dark btn-lg" disabled={!current || next.length < 10}>
            Change password
          </button>
        </div>
      </form>
    </section>
  );
}

/** Your own choice: an email when a call is held. Only approvers and admins get them, since only they can decide. */
function EmailAlerts({ session, onUserChange }: { session: Session; onUserChange: (u: User) => void }) {
  const { user } = session;
  const [state, setState] = useState<{ tone: string; text: string } | null>(null);
  const canDecide = can(session, "approver");

  async function toggle(on: boolean) {
    setState(null);
    try {
      const res = await api<{ user: User }>(session, "/me/alerts", { method: "PATCH", body: { emailAlerts: on } });
      onUserChange(res.user);
      setState({ tone: "good", text: on ? "You'll get an email when a call is held." : "You won't get emails about held calls." });
    } catch (err) {
      setState({ tone: "bad", text: message(err) });
    }
  }

  return (
    <section className="card account-card">
      <header className="account-card-head">
        <h2>Email alerts</h2>
        <p>Approvers and admins can be emailed when a call is held for approval.</p>
      </header>
      <label className={`switch-row ${canDecide ? "" : "is-disabled"}`}>
        <span className="switch-row-icon" aria-hidden="true">
          <Mail size={18} />
        </span>
        <span className="switch-row-text">
          <span className="switch-row-title">Approval requests</span>
          <span className="field-hint">
            {canDecide
              ? `Sent to ${user.email}. The email says what the agent wants and why it was held, and links to the call. You sign in to decide; nothing can be approved from the email.`
              : "Only approvers and admins get alerts, because only they can decide held calls."}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={canDecide && user.emailAlerts}
          disabled={!canDecide}
          onChange={(e) => void toggle(e.target.checked)}
          aria-label="Email me when a call is held for approval"
        />
      </label>
      {state && <p className={`outcome outcome-${state.tone}`}>{state.text}</p>}
    </section>
  );
}

/** Admin only (the server enforces it): the email provider's status and the team's Slack webhook. */
function TeamAlerts({ session }: { session: Session }) {
  const settings = usePoll(() => api<AlertSettings>(session, "/settings/alerts"), 30000);
  const [url, setUrl] = useState("");
  const [state, setState] = useState<{ tone: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = settings.data;

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setState(null);
    try {
      setState({ tone: "good", text: await action() });
    } catch (err) {
      setState({ tone: "bad", text: message(err) });
    }
    setBusy(false);
    settings.refresh();
  }

  const saveSlack = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(session, "/settings/alerts", { method: "PUT", body: { slackWebhookUrl: url.trim() } });
      setUrl("");
      return "Slack webhook saved. Held calls will be posted there.";
    });
  };
  const removeSlack = () => {
    if (!window.confirm("Remove the Slack webhook? Held calls will no longer be posted to Slack.")) return;
    void run(async () => {
      await api(session, "/settings/alerts", { method: "PUT", body: { slackWebhookUrl: null } });
      return "Slack webhook removed.";
    });
  };
  const sendTest = () =>
    void run(async () => {
      const r = await api<{ email: string; slack: string }>(session, "/settings/alerts/test", { method: "POST" });
      return `Test alert: email ${r.email}; Slack ${r.slack}.`;
    });

  return (
    <section className="card account-card">
      <header className="account-card-head">
        <h2>Team alerts</h2>
        <p>When a call is held, or money moves outside Handrail, approvers are alerted by email and, if set, in Slack. Only admins see this.</p>
      </header>
      {settings.error && <p className="error">{settings.error.message}</p>}
      {s && (
        <dl className="kv settings-kv">
          <div>
            <dt>Email</dt>
            <dd>
              {s.email.configured ? (
                <>On, via {s.email.provider}</>
              ) : (
                <>
                  Off. Set <Mono>BREVO_API_KEY</Mono> and <Mono>HANDRAIL_ALERT_FROM</Mono> in the server's environment and restart.
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>{s.email.configured ? "Emailed" : "Would be emailed"}</dt>
            <dd>{s.recipients.length ? s.recipients.join(", ") : "Nobody: no approver or admin has email alerts on."}</dd>
          </div>
          <div>
            <dt>Slack</dt>
            <dd>
              {s.slack.set ? (
                <>
                  <Mono>{s.slack.masked}</Mono>
                  {s.slack.updatedBy && <span className="muted"> · set by {s.slack.updatedBy}</span>}
                </>
              ) : (
                "Off"
              )}
            </dd>
          </div>
        </dl>
      )}
      <form className="inline-form" onSubmit={saveSlack}>
        <input
          className="input"
          type="url"
          placeholder={s?.slack.set ? "Paste a new webhook URL to replace it" : "https://hooks.slack.com/services/…"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Slack incoming webhook URL"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn btn-primary" disabled={busy || !url.trim()}>
          {s?.slack.set ? "Replace webhook" : "Save webhook"}
        </button>
      </form>
      <p className="fine">
        Create one in Slack under Apps → Incoming Webhooks. It's stored on the server and never shown again in full.
      </p>
      <div className="button-row">
        {s?.slack.set && (
          <button className="btn btn-ghost" onClick={removeSlack} disabled={busy}>
            Remove Slack webhook
          </button>
        )}
        <button className="btn btn-secondary" onClick={sendTest} disabled={busy || !s || (!s.email.configured && !s.slack.set)}>
          Send a test alert
        </button>
      </div>
      {state && <p className={`outcome outcome-${state.tone}`}>{state.text}</p>}
    </section>
  );
}
