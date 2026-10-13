import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type AuthState, type Role, type Session, type User } from "../api";
import { Logo, ThemeToggle } from "../components";
import { link } from "../router";

type SignedIn = (s: Session) => void;

const message = (err: unknown) => (err instanceof ApiError ? err.message : String(err));

/** Signs in as the shared demo approver. */
export function useDemoSignIn(onSignedIn: SignedIn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api<Session>(null, "/auth/demo", { method: "POST" }));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }
  return { start, busy, error };
}

function AuthShell({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-page">
      <header className="auth-top">
        <a className="brand" {...link("/")}>
          <Logo />
          <span className="brand-name">Handrail</span>
        </a>
        <ThemeToggle />
      </header>
      <main className="auth-main">
        <div className="auth-card">
          <Logo size={56} className="auth-logo" />
          <h1>{title}</h1>
          {lede && <p className="auth-lede">{lede}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}

export function LoginPage({ auth, onSignedIn }: { auth: AuthState; onSignedIn: SignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const demo = useDemoSignIn(onSignedIn);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api<Session>(null, "/auth/login", { method: "POST", body: { email, password } }));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in" lede="Review held agent payments and see everything your agent did with PayPal.">
      {auth.setupRequired && (
        <p className="notice">
          No accounts yet. <a {...link("/signup")}>Create the admin account</a> to get started.
        </p>
      )}
      <form className="auth-form" onSubmit={submit}>
        <label>
          Email
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {auth.demoAccess && (
        <>
          <div className="or">
            <span>or</span>
          </div>
          <button className="btn btn-secondary btn-block" onClick={demo.start} disabled={demo.busy}>
            {demo.busy ? "Opening the demo…" : "Try the demo"}
          </button>
          <p className="fine">Signs you in as a shared approver on PayPal's sandbox. No real money moves.</p>
          {demo.error && <p className="error" role="alert">{demo.error}</p>}
        </>
      )}
      {!auth.setupRequired && <p className="fine">New here? Ask your Handrail admin for an invite link.</p>}
    </AuthShell>
  );
}

const ROLE_WORDS: Record<Role, string> = {
  admin: "an admin (policies, people and agent keys)",
  approver: "an approver (approve or reject held calls)",
  viewer: "a viewer (read-only)",
};

export function SignupPage({ auth, onSignedIn }: { auth: AuthState; onSignedIn: SignedIn }) {
  const token = new URLSearchParams(location.search).get("invite");
  const [invite, setInvite] = useState<{ email: string; role: Role } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    api<{ email: string; role: Role }>(null, `/auth/invite?token=${encodeURIComponent(token)}`).then(
      (i) => (setInvite(i), setEmail(i.email)),
      (err) => setInviteError(message(err)),
    );
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api<{ user: User; csrfToken: string }>(null, "/auth/signup", { method: "POST", body: { name, email, password, invite: token ?? undefined } }));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  if (!token && !auth.setupRequired) {
    return (
      <AuthShell title="Join Handrail" lede="Handrail already has an admin. Ask them for an invite link, then open it here.">
        <a className="btn btn-secondary btn-block" {...link("/login")}>
          Back to sign in
        </a>
      </AuthShell>
    );
  }
  if (token && inviteError) {
    return (
      <AuthShell title="Invite not valid" lede={inviteError}>
        <a className="btn btn-secondary btn-block" {...link("/login")}>
          Back to sign in
        </a>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={token ? "Accept your invite" : "Create the admin account"}
      lede={
        token
          ? invite
            ? `You're joining as ${ROLE_WORDS[invite.role]}.`
            : "Checking your invite…"
          : "The first account is the admin: it manages policies, people and agent keys, and invites everyone else."
      }
    >
      <form className="auth-form" onSubmit={submit}>
        <label>
          Your name
          <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          <span className="field-hint">Shown on every approval you make, e.g. "Approved by {name || "Malcolm Clottey"}".</span>
        </label>
        <label>
          Email
          <input
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={!!invite}
            required
          />
        </label>
        <label>
          Password
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <span className="field-hint">At least 10 characters. A short sentence works well.</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy || (!!token && !invite)}>
          {busy ? "Creating your account…" : "Create account"}
        </button>
      </form>
      <p className="fine">
        Already have an account? <a {...link("/login")}>Sign in</a>
      </p>
    </AuthShell>
  );
}
