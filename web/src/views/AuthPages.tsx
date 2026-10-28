import { ArrowRight, CirclePlay, Clock, FileText, KeyRound, Lock, Mail, ShieldCheck, User as UserIcon, UserCheck, type LucideIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type AuthState, type Role, type Session, type User } from "../api";
import { Logo, PasswordInput, ThemeToggle } from "../components";
import { link } from "../router";
import { RailArt } from "./Home";

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

type Side = "signin" | "signup";

const SIDES: Record<Side, { tagline: ReactNode; title: ReactNode; body: string; points: Array<[LucideIcon, string, string?]> }> = {
  signin: {
    tagline: (
      <>
        AI agents <span aria-hidden="true">×</span> PayPal <span aria-hidden="true">×</span> Human control
      </>
    ),
    title: (
      <>
        Let your agent
        <br />
        move money,
        <br />
        <em>safely.</em>
      </>
    ),
    body: "Handrail sits between your agent and PayPal, enforcing your rules, requiring approval when needed, and keeping a verifiable record of every action.",
    points: [
      [ShieldCheck, "Deterministic policy enforcement"],
      [UserCheck, "Human approval for sensitive actions"],
      [FileText, "Tamper-evident audit log"],
    ],
  },
  signup: {
    tagline: "AI agents. Real payments. Safer outcomes.",
    title: "Give your AI agents a handrail for payments.",
    body: "Handrail sits between your AI agents and PayPal, applying your rules, requiring approval when needed, and keeping a tamper-evident record.",
    points: [
      [ShieldCheck, "Enforce your rules", "Block, hold or allow based on clear policies."],
      [Clock, "Keep a human in the loop", "Review sensitive actions before they happen."],
      [FileText, "Tamper-evident records", "A complete audit trail for every request and decision."],
    ],
  },
};

/** The split sign-in / sign-up layout: the brand story on the left, the form on the right. */
function AuthShell({ side, aside, children }: { side: Side; aside: ReactNode; children: ReactNode }) {
  const story = SIDES[side];
  return (
    <div className={`auth-split auth-split-${side}`}>
      <section className="auth-story">
        {side === "signin" ? (
          <div className="auth-story-bg auth-story-photo" aria-hidden="true" />
        ) : (
          <div className="auth-story-bg" aria-hidden="true">
            <RailArt />
          </div>
        )}
        <header className="auth-story-top">
          <a className="auth-brand" {...link("/")} aria-label="Handrail home">
            <Logo size={46} className="logo auth-brand-logo" />
            <span>Handrail</span>
          </a>
          <p className="auth-tagline">{story.tagline}</p>
        </header>
        <div className="auth-story-copy">
          <h2 className="auth-story-title">{story.title}</h2>
          <p className="auth-story-body">{story.body}</p>
          <ul className={`auth-points ${side === "signup" ? "auth-points-rich" : ""}`}>
            {story.points.map(([Icon, title, detail]) => (
              <li key={title}>
                <span className="auth-point-icon" aria-hidden="true">
                  <Icon size={19} />
                </span>
                <span>
                  <span className="auth-point-title">{title}</span>
                  {detail && <span className="auth-point-detail">{detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {side === "signup" && <HeldCardArt />}
      </section>
      <section className="auth-pane">
        <header className="auth-pane-top">
          {aside}
          <ThemeToggle className="auth-icon-btn" />
        </header>
        <main className="auth-pane-main">{children}</main>
      </section>
    </div>
  );
}

/** A held refund, as the approval queue shows it. Decorative only. */
function HeldCardArt() {
  return (
    <div className="auth-art-card" aria-hidden="true">
      <div className="auth-art-head">
        <span className="auth-art-icon">
          <Logo size={30} />
        </span>
        <span>
          <span className="auth-art-title">Refund request</span>
          <span className="auth-art-amount num">$250.00 USD</span>
        </span>
        <span className="auth-art-pill">Needs approval</span>
      </div>
      <dl className="auth-art-rows">
        <dt>Requested by</dt>
        <dd>Support agent</dd>
        <dt>Customer</dt>
        <dd>Alex Chen</dd>
        <dt>Agent says</dt>
        <dd>“Item arrived damaged”</dd>
      </dl>
      <div className="auth-art-actions">
        <span>Reject</span>
        <span className="auth-art-approve">Approve</span>
      </div>
    </div>
  );
}

/** A labelled input with an icon inside it on the left. */
function IconField({ label, icon: Icon, hint, children }: { label: ReactNode; icon: LucideIcon; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="auth-field">
      <span className="auth-label">{label}</span>
      <span className="icon-input">
        <Icon size={18} className="icon-input-icon" aria-hidden="true" />
        {children}
      </span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
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

  const fromAlert = new URLSearchParams(location.search).get("next")?.startsWith("/app#approvals/");
  return (
    <AuthShell
      side="signin"
      aside={
        auth.setupRequired ? (
          <>
            <span className="auth-aside-text">No accounts yet?</span>
            <a className="auth-aside-btn" {...link("/signup")}>
              Set up Handrail
            </a>
          </>
        ) : (
          <span className="auth-aside-text">New here? Ask your admin for an invite link.</span>
        )
      }
    >
      <div className="auth-card">
        <a className="auth-card-brand" {...link("/")} aria-label="Handrail home">
          <Logo size={52} />
          <span>Handrail</span>
        </a>
        <h1>Sign in</h1>
        <p className="auth-lede">Access your Handrail workspace.</p>

        <div className="auth-notice">
          <Lock size={18} aria-hidden="true" />
          <span>
            <strong>{fromAlert ? "Sign in to review the held call from your alert." : "You're signing in to the Handrail sandbox."}</strong>
            {fromAlert ? "You'll go straight to it." : "No real PayPal money is used."}
          </span>
        </div>
        {auth.setupRequired && (
          <p className="notice">
            No accounts yet. <a {...link("/signup")}>Create the admin account</a> to get started.
          </p>
        )}

        <form className="auth-form" onSubmit={submit}>
          <IconField label="Email" icon={Mail}>
            <input
              className="input"
              type="email"
              autoComplete="username"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </IconField>
          <IconField label="Password" icon={Lock}>
            <PasswordInput
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </IconField>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="auth-submit" disabled={busy || !email || !password}>
            <span>{busy ? "Signing in…" : "Sign in"}</span>
            <ArrowRight size={20} aria-hidden="true" />
          </button>
        </form>

        {auth.demoAccess && (
          <>
            <div className="auth-or">
              <span>or</span>
            </div>
            <button className="auth-demo" onClick={demo.start} disabled={demo.busy}>
              <span className="auth-demo-icon" aria-hidden="true">
                <CirclePlay size={24} />
              </span>
              <span className="auth-demo-text">
                <span className="auth-demo-title">{demo.busy ? "Opening the demo…" : "Try the demo"}</span>
                <span className="auth-demo-sub">Explore Handrail as an approver on PayPal's sandbox</span>
              </span>
              <ArrowRight size={20} aria-hidden="true" />
            </button>
            {demo.error && (
              <p className="error" role="alert">
                {demo.error}
              </p>
            )}
          </>
        )}
        <p className="auth-fine">
          {auth.demoAccess ? "The demo signs you in as a shared approver. No real money moves. " : ""}
          {!auth.setupRequired && "New here? Ask your Handrail admin for an invite link."}
        </p>
      </div>
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
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsSetupToken = !token && !!auth.setupTokenRequired;

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
      onSignedIn(await api<{ user: User; csrfToken: string }>(null, "/auth/signup", { method: "POST", body: { name, email, password, invite: token ?? undefined, setupToken: needsSetupToken ? setupToken : undefined } }));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  const signInAside = (
    <>
      <span className="auth-aside-text">Already have an account?</span>
      <a className="auth-aside-btn" {...link("/login")}>
        Sign in
      </a>
    </>
  );

  if (!token && !auth.setupRequired) {
    return (
      <AuthShell side="signup" aside={signInAside}>
        <SignupHead kicker="Invite only" title="Join Handrail" lede="Handrail already has an admin. Ask them for an invite link, then open it here." />
        <a className="auth-submit auth-submit-secondary" {...link("/login")}>
          <span>Back to sign in</span>
          <ArrowRight size={20} aria-hidden="true" />
        </a>
      </AuthShell>
    );
  }
  if (token && inviteError) {
    return (
      <AuthShell side="signup" aside={signInAside}>
        <SignupHead kicker="Accept your invite" title="Invite not valid" lede={inviteError} />
        <a className="auth-submit auth-submit-secondary" {...link("/login")}>
          <span>Back to sign in</span>
          <ArrowRight size={20} aria-hidden="true" />
        </a>
      </AuthShell>
    );
  }

  return (
    <AuthShell side="signup" aside={signInAside}>
      <SignupHead
        kicker={token ? "Accept your invite" : "Create your account"}
        title={token ? "Join your team on Handrail" : "Create the admin account"}
        lede={
          token
            ? invite
              ? `You're joining as ${ROLE_WORDS[invite.role]}. Handrail runs on PayPal's sandbox only.`
              : "Checking your invite…"
            : "The first account is the admin: it manages policies, people and agent keys, and invites everyone else. Handrail runs on PayPal's sandbox only."
        }
      />
      <form className="auth-form auth-form-card" onSubmit={submit}>
        <IconField label="Your name" icon={UserIcon} hint={<>Shown on every approval you make, e.g. “Approved by {name || "Malcolm Clottey"}”.</>}>
          <input className="input" autoComplete="name" placeholder="e.g. Ada Lovelace" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </IconField>
        <IconField label="Email" icon={Mail}>
          <input
            className="input"
            type="email"
            autoComplete="username"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={!!invite}
            required
          />
        </IconField>
        <IconField label="Password" icon={Lock} hint="At least 10 characters. A short sentence works well.">
          <PasswordInput
            autoComplete="new-password"
            placeholder="Choose a password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </IconField>
        {needsSetupToken && (
          <IconField label="Setup token" icon={KeyRound} hint="The HANDRAIL_SETUP_TOKEN value from the server's environment. Only the person deploying Handrail has it.">
            <PasswordInput autoComplete="off" placeholder="Paste the setup token" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
          </IconField>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="auth-submit auth-submit-block" disabled={busy || (!!token && !invite)}>
          <span>{busy ? "Creating your account…" : "Create account"}</span>
        </button>
      </form>
      <div className="auth-or">
        <span>or</span>
      </div>
      <p className="auth-switch">
        Already have an account? <a {...link("/login")}>Sign in</a>
      </p>
    </AuthShell>
  );
}

function SignupHead({ kicker, title, lede }: { kicker: string; title: string; lede: ReactNode }) {
  return (
    <div className="signup-head">
      <p className="eyebrow">{kicker}</p>
      <h1>{title}</h1>
      <p className="signup-lede">{lede}</p>
    </div>
  );
}
