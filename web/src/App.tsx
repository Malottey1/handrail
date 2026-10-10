import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Session, type Summary, type VerifyResult } from "./api";
import { usePoll } from "./components";
import { ActivityView } from "./views/Activity";
import { ApprovalsView } from "./views/Approvals";
import { AuditView } from "./views/Audit";
import { PolicyView } from "./views/Policy";
import { WebhooksView } from "./views/Webhooks";

const STORAGE_KEY = "handrail.session";
const TABS = ["approvals", "activity", "webhooks", "audit", "policy"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  approvals: "Approvals",
  activity: "Activity",
  webhooks: "Webhooks",
  audit: "Audit log",
  policy: "Policy",
};

// Per-tab session: closing the tab signs out. Storage can be unavailable
// (private windows, blocked site data), so every access is guarded.
function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not persisted; the session lasts until reload.
  }
}

function tabFromHash(): Tab {
  const t = location.hash.slice(1) as Tab;
  return TABS.includes(t) ? t : "approvals";
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const signOut = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);

  if (!session) {
    return (
      <SignIn
        onSignIn={(s) => {
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }
  return <Dashboard session={session} onSignOut={signOut} />;
}

function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const summary = usePoll(() => api<Summary>(session, "/summary"), 3000);
  const verify = usePoll(() => api<VerifyResult>(session, "/audit/verify"), 10000);

  // A rotated admin token signs everyone out instead of failing silently.
  useEffect(() => {
    if (summary.error instanceof ApiError && summary.error.status === 401) onSignOut();
  }, [summary.error, onSignOut]);

  const s = summary.data;
  const pending = s?.pendingApprovals ?? 0;
  useEffect(() => {
    document.title = pending > 0 ? `(${pending}) Handrail` : "Handrail";
  }, [pending]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span className="brand-name">Handrail</span>
          <span className="env">Sandbox</span>
        </div>
        <IntegrityBadge verify={verify.data} error={verify.error} onClick={() => (location.hash = "audit")} />
        <div className="who">
          <span>{session.name}</span>
          <button className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {summary.error && !(summary.error instanceof ApiError && summary.error.status === 401) && (
        <div className="banner">Can't reach Handrail: {summary.error.message}. Retrying…</div>
      )}

      <section className="stats" aria-label="Last 24 hours">
        <Stat label="Waiting for approval" value={pending} tone={pending > 0 ? "warn" : undefined} />
        <Stat label="Agent calls (24h)" value={s?.last24h.calls} />
        <Stat label="Sent to PayPal" value={s?.last24h.forwarded} />
        <Stat label="Blocked" value={s?.last24h.blocked} />
        <Stat label="Duplicates stopped" value={s?.last24h.duplicates} />
        <Stat label="Webhook flags" value={s?.webhooks.flagged} tone={s && s.webhooks.flagged > 0 ? "bad" : undefined} />
      </section>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <a key={t} href={`#${t}`} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "active" : ""}`}>
            {TAB_LABELS[t]}
            {t === "approvals" && pending > 0 && <span className="tab-badge">{pending}</span>}
          </a>
        ))}
      </nav>

      <main className="main">
        {tab === "approvals" && <ApprovalsView session={session} onChange={summary.refresh} />}
        {tab === "activity" && <ActivityView session={session} />}
        {tab === "webhooks" && <WebhooksView session={session} />}
        {tab === "audit" && <AuditView session={session} verify={verify.data} />}
        {tab === "policy" && <PolicyView session={session} />}
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | undefined; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <span className="stat-value">{value ?? "–"}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function IntegrityBadge({ verify, error, onClick }: { verify: VerifyResult | null; error: Error | null; onClick: () => void }) {
  if (!verify) {
    return (
      <button className="integrity" onClick={onClick}>
        {error ? "Audit log: can't check" : "Checking audit log…"}
      </button>
    );
  }
  return (
    <button className={`integrity ${verify.ok ? "ok" : "bad"}`} onClick={onClick} title={`Head hash ${verify.head}`}>
      <span className="dot" />
      {verify.ok ? "Audit log intact" : `Tampering detected (${verify.problems.length})`}
      <span className="integrity-meta">
        {verify.entries} entries · {verify.head.slice(0, 8)}
      </span>
    </button>
  );
}

function SignIn({ onSignIn }: { onSignIn: (s: Session) => void }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const session = { token: token.trim(), name: name.trim() || "admin" };
    setBusy(true);
    setError(null);
    try {
      await api<Summary>(session, "/summary");
      onSignIn(session);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "That admin token isn't right." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <div className="brand">
          <Logo />
          <span className="brand-name">Handrail</span>
        </div>
        <p className="signin-lede">Approve held agent payments, and see everything the agent did with PayPal.</p>
        <label>
          Your name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Recorded with each decision" autoFocus />
        </label>
        <label>
          Admin token
          <input
            className="input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="HANDRAIL_ADMIN_TOKEN from .env"
            autoComplete="current-password"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !token.trim()}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path d="M6 11h20M9 11v13M16 11v13M23 11v13" stroke="var(--logo-ink)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
