import {
  Activity,
  BadgeDollarSign,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Files,
  House,
  LogOut,
  Menu,
  Moon,
  ScrollText,
  Search,
  Settings,
  Sun,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, can, type AlertChannels, type AuthState, type Session, type Summary, type User, type VerifyResult } from "./api";
import { Logo, PageHeader, usePoll } from "./components";
import { link, navigate, usePath } from "./router";
import { setTheme, useTheme } from "./theme";
import { AccountView } from "./views/Account";
import { ActivityView } from "./views/Activity";
import { ApprovalsView } from "./views/Approvals";
import { AuditView } from "./views/Audit";
import { LoginPage, SignupPage } from "./views/AuthPages";
import { DashboardView } from "./views/Dashboard";
import { HomePage } from "./views/Home";
import { PolicyView } from "./views/Policy";
import { SetupView } from "./views/Setup";
import { TeamView } from "./views/Team";
import { WebhooksView } from "./views/Webhooks";

const TABS = ["dashboard", "approvals", "activity", "webhooks", "audit", "policy", "setup", "team", "account"] as const;
type Tab = (typeof TABS)[number];
const NAV: Record<Tab, { label: string; icon: LucideIcon; subtitle: string }> = {
  dashboard: { label: "Dashboard", icon: House, subtitle: "" },
  approvals: { label: "Approvals", icon: BadgeDollarSign, subtitle: "Review and approve money-moving actions from your agents." },
  activity: { label: "Activity", icon: Activity, subtitle: "Explore every call your agents make through Handrail." },
  webhooks: { label: "Webhooks", icon: Webhook, subtitle: "Reconcile PayPal events with agent activity and spot anything that bypassed Handrail." },
  audit: { label: "Audit log", icon: Files, subtitle: "A tamper-evident record of every decision, request and system event." },
  policy: { label: "Policy", icon: ScrollText, subtitle: "Define the guardrails for what your agents can do with PayPal." },
  setup: { label: "Setup", icon: Settings, subtitle: "Connect your agent through Handrail, and make sure nothing goes around it." },
  team: { label: "Team & keys", icon: Users, subtitle: "Manage who has access, what they can do, and the keys your agents use to connect." },
  account: { label: "Account", icon: CircleUser, subtitle: "Manage your profile, your password and how you're alerted." },
};
/** Pages whose list the top bar's search filters. */
const SEARCH: Partial<Record<Tab, string>> = {
  approvals: "Search by amount, agent, customer, rule or id…",
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
  return TABS.includes(t) ? t : "dashboard";
}

function focusFromHash(): string | null {
  const [t, id] = location.hash.slice(1).split("/");
  return t === "approvals" && id && /^apr_[a-z0-9]+$/.test(id) ? id : null;
}

function Dashboard({ session, onSignOut, onUserChange }: { session: Session; onSignOut: () => void; onUserChange: (u: User) => void }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [focus, setFocus] = useState<string | null>(focusFromHash);
  const [navOpen, setNavOpen] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash());
      setFocus(focusFromHash());
      setNavOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Each page starts with an empty search.
  useEffect(() => setSearch(""), [tab]);

  const summary = usePoll(() => api<Summary>(session, "/summary"), 3000);
  const verify = usePoll(() => api<VerifyResult>(session, "/audit/verify"), 10000);

  const s = summary.data;
  const pending = s?.pendingApprovals ?? 0;
  useEffect(() => {
    document.title = pending > 0 ? `(${pending}) Handrail` : "Handrail";
  }, [pending]);

  const tabs = TABS.filter((t) => t !== "team" || can(session, "admin"));
  const shown = tab === "team" && !can(session, "admin") ? "dashboard" : tab;
  const page = NAV[shown];
  const searchHint = SEARCH[shown];

  return (
    <div className={`shell ${navOpen ? "nav-open" : ""}`}>
      <aside className="sidebar" aria-label="Handrail">
        <div className="sidebar-top">
          <a className="sidebar-brand" {...link("/")} aria-label="Handrail home">
            <Logo size={38} />
            <span>Handrail</span>
          </a>
          <button className="icon-btn sidebar-close" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>
        <nav className="side-nav">
          {tabs.map((t) => {
            const Icon = NAV[t].icon;
            return (
              <a key={t} href={`#${t}`} className={`side-link ${shown === t ? "active" : ""}`} aria-current={shown === t ? "page" : undefined}>
                <Icon size={20} aria-hidden="true" />
                <span>{NAV[t].label}</span>
                {t === "approvals" && pending > 0 && (
                  <span className="side-badge" aria-label={`${pending} waiting`}>
                    {pending}
                  </span>
                )}
              </a>
            );
          })}
        </nav>
        <UserMenu session={session} onSignOut={onSignOut} placement="up">
          {(open, toggle) => (
            <button className="side-user" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
              <Avatar name={session.user.name} />
              <span className="side-user-text">
                <span className="side-user-name">{session.user.name}</span>
                <span className="side-user-role">{ROLE_LABELS[session.user.role]}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          )}
        </UserMenu>
      </aside>
      <div className="sidebar-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <div className="shell-main">
        <header className="topbar">
          <button className="icon-btn topbar-menu" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Menu size={20} />
          </button>
          <span className="env-chip">
            <span className="env-dot" aria-hidden="true" />
            Sandbox
          </span>
          {searchHint && (
            <label className="topbar-search">
              <Search size={17} aria-hidden="true" />
              <input type="search" placeholder={searchHint} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={searchHint} />
            </label>
          )}
          <div className="topbar-right">
            {s && <AlertsChip alerts={s.alerts} />}
            <IntegrityBadge verify={verify.data} error={verify.error} onClick={() => (location.hash = "audit")} />
            <UserMenu session={session} onSignOut={onSignOut} placement="down">
              {(open, toggle) => (
                <button className="topbar-user" onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label="Your account">
                  <Avatar name={session.user.name} />
                  <ChevronDown size={18} aria-hidden="true" />
                </button>
              )}
            </UserMenu>
          </div>
        </header>

        <div className="canvas">
          {session.user.isDemo && (
            <div className="banner banner-demo">
              You're in your own demo workspace on PayPal's sandbox, signed in as an approver. No real money moves, and nobody else sees
              what you do here. Start with "Run demo agent" on the Approvals page.
            </div>
          )}
          {s && s.unattributed.last30d > 0 && (
            <a className="banner banner-flag" href="#activity">
              PayPal reported {s.unattributed.last30d} money-out action{s.unattributed.last30d === 1 ? "" : "s"} in the last 30 days that
              didn't go through Handrail. Something may be bypassing it. See Activity, and check the Setup tab.
            </a>
          )}
          {summary.error && !(summary.error instanceof ApiError && summary.error.status === 401) && (
            <div className="banner banner-bad">Can't reach Handrail: {summary.error.message}. Retrying…</div>
          )}

          <main className="page">
            {shown !== "dashboard" && shown !== "approvals" && <PageHeader title={page.label} subtitle={page.subtitle} />}
            {shown === "dashboard" && <DashboardView session={session} summary={s} />}
            {shown === "approvals" && (
              <ApprovalsView session={session} onChange={summary.refresh} focus={focus} search={search} title={page.label} subtitle={page.subtitle} />
            )}
            {shown === "activity" && <ActivityView session={session} />}
            {shown === "webhooks" && <WebhooksView session={session} />}
            {shown === "audit" && <AuditView session={session} verify={verify.data} />}
            {shown === "policy" && <PolicyView session={session} />}
            {shown === "setup" && <SetupView session={session} />}
            {shown === "team" && <TeamView session={session} />}
            {shown === "account" && <AccountView session={session} onUserChange={onUserChange} />}
          </main>
        </div>
      </div>
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

function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** Account, theme and sign-out, from the user card in the sidebar or the avatar in the top bar. */
function UserMenu({
  session,
  onSignOut,
  placement,
  children,
}: {
  session: Session;
  onSignOut: () => void;
  placement: "up" | "down";
  children: (open: boolean, toggle: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <div className={`user-menu user-menu-${placement}`} ref={ref}>
      {children(open, () => setOpen(!open))}
      {open && (
        <div className="menu" role="menu">
          <div className="menu-who">
            <span className="menu-name">{session.user.name}</span>
            <span className="menu-email">{session.user.email}</span>
            <span className={`role role-${session.user.role}`}>{ROLE_LABELS[session.user.role]}</span>
          </div>
          <a className="menu-item" role="menuitem" href="#account" onClick={() => setOpen(false)}>
            <CircleUser size={17} aria-hidden="true" /> Account
          </a>
          <button className="menu-item" role="menuitem" onClick={() => setTheme(next)}>
            {theme === "dark" ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <button className="menu-item" role="menuitem" onClick={onSignOut}>
            <LogOut size={17} aria-hidden="true" /> Sign out
          </button>
        </div>
      )}
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

const shortHash = (h: string) => (h.length > 10 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h);

function IntegrityBadge({ verify, error, onClick }: { verify: VerifyResult | null; error: Error | null; onClick: () => void }) {
  if (!verify) {
    return (
      <button className="integrity" onClick={onClick}>
        <span className="dot" aria-hidden="true" />
        {error ? "Audit log: can't check" : "Checking audit log…"}
      </button>
    );
  }
  return (
    <button className={`integrity ${verify.ok ? "ok" : "bad"}`} onClick={onClick} title={`Head hash ${verify.head}`}>
      <span className="dot" aria-hidden="true" />
      <span className="integrity-label">{verify.ok ? "Audit log intact" : `Tampering detected (${verify.problems.length})`}</span>
      <span className="integrity-meta">
        · {verify.entries.toLocaleString()} entries · {shortHash(verify.head)}
      </span>
    </button>
  );
}
