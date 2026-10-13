import { useState, type FormEvent } from "react";
import { api, ApiError, can, type AlertSettings, type Session, type User } from "../api";
import { Mono, usePoll } from "../components";

const message = (err: unknown) => (err instanceof ApiError ? err.message : String(err));

/** Your own profile, password and alerts; for admins, the team's alert settings. */
export function AccountView({ session, onUserChange }: { session: Session; onUserChange: (u: User) => void }) {
  const { user } = session;
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [profile, setProfile] = useState<{ tone: string; text: string } | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [password, setPassword] = useState<{ tone: string; text: string } | null>(null);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api<{ user: User }>(session, "/me", { method: "PATCH", body: { name, email } });
      onUserChange(res.user);
      setProfile({ tone: "good", text: "Saved." });
    } catch (err) {
      setProfile({ tone: "bad", text: message(err) });
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    try {
      await api(session, "/me/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      setCurrent("");
      setNext("");
      setPassword({ tone: "good", text: "Password changed. Other devices have been signed out." });
    } catch (err) {
      setPassword({ tone: "bad", text: message(err) });
    }
  }

  if (user.isDemo) {
    return (
      <section className="card account">
        <h2 className="section-title">Demo account</h2>
        <p>
          You're signed in as <strong>{user.name}</strong>, a shared approver account for trying Handrail on PayPal's sandbox. Its
          name, email and password can't be changed.
        </p>
        <p>
          Held-call alerts are never emailed from the demo. Each held call shows an <strong>alert preview</strong> instead: the email
          approvers would get, with a link back to the call.
        </p>
      </section>
    );
  }

  return (
    <div className="account">
      <section className="card">
        <h2 className="section-title">Profile</h2>
        <p className="section-help">Your name is recorded with every approval and policy change you make.</p>
        <form className="stack-form" onSubmit={saveProfile}>
          <label>
            Name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />
          </label>
          <label>
            Email
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <p className="fine">
            Role: <strong>{user.role}</strong>. Only an admin can change roles.
          </p>
          {profile && <p className={`outcome outcome-${profile.tone}`}>{profile.text}</p>}
          <button className="btn btn-primary" disabled={name.trim() === user.name && email.trim().toLowerCase() === user.email}>
            Save profile
          </button>
        </form>
      </section>

      <EmailAlerts session={session} onUserChange={onUserChange} />
      {can(session, "admin") && <TeamAlerts session={session} />}

      <section className="card">
        <h2 className="section-title">Password</h2>
        <form className="stack-form" onSubmit={changePassword}>
          <label>
            Current password
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
          </label>
          <label>
            New password
            <input
              className="input"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={10}
              autoComplete="new-password"
            />
            <span className="field-hint">At least 10 characters.</span>
          </label>
          {password && <p className={`outcome outcome-${password.tone}`}>{password.text}</p>}
          <button className="btn btn-primary" disabled={!current || next.length < 10}>
            Change password
          </button>
        </form>
      </section>
    </div>
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
    <section className="card">
      <h2 className="section-title">Email alerts</h2>
      <label className={`toggle ${canDecide ? "" : "toggle-disabled"}`}>
        <input type="checkbox" checked={canDecide && user.emailAlerts} disabled={!canDecide} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          Email me when a call is held for approval
          <span className="field-hint">
            {canDecide
              ? `Sent to ${user.email}. The email says what the agent wants and why it was held, and links to the call. You sign in to decide; nothing can be approved from the email.`
              : "Only approvers and admins get alerts, because only they can decide held calls."}
          </span>
        </span>
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
    <section className="card">
      <h2 className="section-title">Team alerts</h2>
      <p className="section-help">When a call is held, Handrail alerts approvers by email and, if set, in Slack. Only admins see this.</p>
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
