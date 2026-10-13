import { useCallback, useEffect, useState } from "react";
import { api, ApiError, can, type AlertChannels, type AuthState, type Session, type Summary, type User, type VerifyResult } from "./api";
import { Logo, ThemeToggle, usePoll } from "./components";
import { link, navigate, usePath } from "./router";
import { AccountView } from "./views/Account";
import { ActivityView } from "./views/Activity";
import { ApprovalsView } from "./views/Approvals";
import { AuditView } from "./views/Audit";
import { LoginPage, SignupPage } from "./views/AuthPages";
import { HomePage } from "./views/Home";
import { PolicyView } from "./views/Policy";
import { SetupView } from "./views/Setup";
import { TeamView } from "./views/Team";
import { WebhooksView } from "./views/Webhooks";

const TABS = ["approvals", "activity", "webhooks", "audit", "policy", "setup", "team", "account"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  approvals: "Approvals",
  activity: "Activity",
  webhooks: "Webhooks",
  audit: "Audit log",
  policy: "Policy",
  setup: "Setup",
  team: "Team & keys",
  account: "Account",
};
const ROLE_LABELS = { admin: "Admin", approver: "Approver", viewer: "Viewer" } as const;

/** Loads who is signed in, then shows the page for the current path. */
export function App() {
  const path = usePath();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(() => {
    api<AuthState>(null, "/auth/session").then(
      (a) => (setAuth(a), setError(null)),
      (e: Error) => setError(e),
    );
  }, []);
  useEffect(reload, [reload]);

  // Any 401 (session expired, signed out elsewhere, account disabled) re-checks the session.
  useEffect(() => {
    window.addEventListener("handrail:signed-out", reload);
    return () => window.removeEventListener("handrail:signed-out", reload);
  }, [reload]);

  if (!auth) {
    return (
      <div className="page-center">
        {error ? <p className="error">Can't reach Handrail: {error.message}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const session: Session | null = auth.user && auth.csrfToken ? { user: auth.user, csrfToken: auth.csrfToken } : null;
  const signedIn = (s: Session) => {
    setAuth({ ...auth, user: s.user, csrfToken: s.csrfToken, setupRequired: false });
    navigate(nextPath());
  };

  if (path === "/login") return session ? <Redirect to={nextPath()} /> : <LoginPage auth={auth} onSignedIn={signedIn} />;
  if (path === "/signup") return session ? <Redirect to="/app" /> : <SignupPage auth={auth} onSignedIn={signedIn} />;
  if (path === "/app") {
    // Signed out (e.g. opening an alert's link): sign in, then come back to the same place.
    if (!session) return <Redirect to={`/login?next=${encodeURIComponent(`/app${location.hash}`)}`} />;
    return (
      <Dashboard
        session={session}
        onUserChange={(user) => setAuth({ ...auth, user })}
        onSignOut={async () => {
          await api(session, "/auth/logout", { method: "POST" }).catch(() => {});
          setAuth({ ...auth, user: null, csrfToken: null });
          navigate("/");
        }}
      />
    );
  }
  return <HomePage auth={auth} session={session} onSignedIn={signedIn} />;
}

/** Where to go after signing in: the dashboard, or the dashboard link that sent you to sign in. */
function nextPath(): string {
  const next = new URLSearchParams(location.search).get("next");
  return next && /^\/app(#[\w/-]*)?$/.test(next) ? next : "/app";
}

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

/** "#activity" -> the Activity tab; "#approvals/apr_…" -> the Approvals tab, focused on that approval (links in alerts). */
function tabFromHash(): Tab {
  const t = location.hash.slice(1).split("/")[0] as Tab;
  return TABS.includes(t) ? t : "approvals";
}

function focusFromHash(): string | null {
  const [t, id] = location.hash.slice(1).split("/");
  return t === "approvals" && id && /^apr_[a-z0-9]+$/.test(id) ? id : null;
}

function Dashboard({ session, onSignOut, onUserChange }: { session: Session; onSignOut: () => void; onUserChange: (u: User) => void }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [focus, setFocus] = useState<string | null>(focusFromHash);
  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash());
      setFocus(focusFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const summary = usePoll(() => api<Summary>(session, "/summary"), 3000);
  const verify = usePoll(() => api<VerifyResult>(session, "/audit/verify"), 10000);

  const s = summary.data;
  const pending = s?.pendingApprovals ?? 0;
  useEffect(() => {
    document.title = pending > 0 ? `(${pending}) Handrail` : "Handrail";
  }, [pending]);

  const tabs = TABS.filter((t) => t !== "account" && (t !== "team" || can(session, "admin")));
  const shown = tab === "team" && !can(session, "admin") ? "approvals" : tab;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" {...link("/")} aria-label="Handrail home">
          <Logo />
          <span className="brand-name">Handrail</span>
          <span className="env">Sandbox</span>
        </a>
        <IntegrityBadge verify={verify.data} error={verify.error} onClick={() => (location.hash = "audit")} />
        {s && <AlertsChip alerts={s.alerts} />}
        <div className="who">
          <a className={`user-chip ${shown === "account" ? "active" : ""}`} href="#account" title="Your account">
            <span className="avatar" aria-hidden="true">
              {initials(session.user.name)}
            </span>
            <span className="user-name">{session.user.name}</span>
            <span className={`role role-${session.user.role}`}>{ROLE_LABELS[session.user.role]}</span>
          </a>
          <ThemeToggle />
          <button className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {session.user.isDemo && (
        <div className="banner banner-demo">
          You're in your own demo workspace on PayPal's sandbox, signed in as an approver. No real money moves, and nobody else sees
          what you do here. Start with "Run demo agent" below.
        </div>
      )}
      {s && s.unattributed.last30d > 0 && (
        <a className="banner banner-flag" href="#activity">
          PayPal reported {s.unattributed.last30d} money-out action{s.unattributed.last30d === 1 ? "" : "s"} in the last 30 days that
          didn't go through Handrail. Something may be bypassing it. See Activity, and check the Setup tab.
        </a>
      )}
      {summary.error && !(summary.error instanceof ApiError && summary.error.status === 401) && (
        <div className="banner">Can't reach Handrail: {summary.error.message}. Retrying…</div>
      )}

      <section className="stats" aria-label="Last 24 hours">
        <Stat label="Waiting for approval" value={pending} tone={pending > 0 ? "warn" : undefined} />
        <Stat label="Agent calls (24h)" value={s?.last24h.calls} />
        <Stat label="Sent to PayPal" value={s?.last24h.forwarded} />
        <Stat label="Blocked" value={s?.last24h.blocked} />
        <Stat label="Duplicates stopped" value={s?.last24h.duplicates} />
        <Stat label="Webhook flags" value={s?.webhooks.flagged} tone={s && s.webhooks.flagged > 0 ? "flag" : undefined} />
      </section>

      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <a key={t} href={`#${t}`} role="tab" aria-selected={shown === t} className={`tab ${shown === t ? "active" : ""}`}>
            {TAB_LABELS[t]}
            {t === "approvals" && pending > 0 && <span className="tab-badge">{pending}</span>}
          </a>
        ))}
      </nav>

      <main className="main">
        {shown === "approvals" && <ApprovalsView session={session} onChange={summary.refresh} focus={focus} />}
        {shown === "activity" && <ActivityView session={session} />}
        {shown === "webhooks" && <WebhooksView session={session} />}
        {shown === "audit" && <AuditView session={session} verify={verify.data} />}
        {shown === "policy" && <PolicyView session={session} />}
        {shown === "setup" && <SetupView session={session} />}
        {shown === "team" && <TeamView session={session} />}
        {shown === "account" && <AccountView session={session} onUserChange={onUserChange} />}
      </main>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

function Stat({ label, value, tone }: { label: string; value: number | undefined; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <span className="stat-value">{value ?? "–"}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** Whether held calls alert anyone. Links to Account, where alerts are set up. */
function AlertsChip({ alerts }: { alerts: AlertChannels }) {
  const [label, tone, title] =
    alerts.mode === "preview"
      ? ["Alerts: preview only", "info", "Demo workspace: alerts are shown on each held call instead of being sent."]
      : alerts.email || alerts.slack
        ? [`Alerts on: ${[alerts.email && "email", alerts.slack && "Slack"].filter(Boolean).join(" + ")}`, "ok", "Approvers are alerted when a call is held."]
        : ["Alerts off", "off", "Nobody is alerted when a call is held. Set up email or Slack in Account."];
  return (
    <a className={`alerts-chip alerts-${tone}`} href="#account" title={title}>
      <span className="dot" aria-hidden="true" />
      {label}
    </a>
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
