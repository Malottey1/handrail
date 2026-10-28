import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Ban,
  Check,
  CircleCheck,
  CirclePlay,
  Clock,
  Copy,
  CreditCard,
  Gavel,
  Undo2,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, type ActivityStats, type Approval, type CallRow, type Session, type SetupChecklist, type Summary } from "../api";
import { Sparkline, StatusPill, ToolIcon, useNow, usePoll } from "../components";
import { callAmount, countdown, formatMoney, formatMoneyList, timeAgo, toolLabel } from "../format";

const TOOLS: Array<[string, string]> = [
  ["", "All actions"],
  ["create_refund", "Refunds"],
  ["pay_order", "Captures"],
  ["accept_dispute_claim", "Dispute concessions"],
  ["cancel_subscription", "Subscription cancellations"],
];

/** The landing page: what needs attention now, and what the agents did in the last 24 hours. */
export function DashboardView({ session, summary }: { session: Session; summary: Summary | null }) {
  const [tool, setTool] = useState("");
  const stats = usePoll(() => api<ActivityStats>(session, `/stats/activity?hours=24${tool ? `&tool=${tool}` : ""}`), 15000, tool);
  const overall = usePoll(() => api<ActivityStats>(session, "/stats/activity?hours=24"), 15000);
  const pending = usePoll(() => api<Approval[]>(session, "/approvals?status=pending"), 3000);
  const calls = usePoll(() => api<CallRow[]>(session, "/calls?limit=6"), 5000);
  const setup = usePoll(() => api<SetupChecklist>(session, "/setup"), 30000);
  const now = useNow(15000);

  const o = overall.data;
  const firstName = session.user.name.split(/\s+/)[0] ?? session.user.name;
  const hour = new Date(now).getHours();
  const greeting = hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const spark = (key: "calls" | "sent" | "held" | "blocked" | "duplicates") => o?.buckets.slice(-8).map((b) => b[key]);

  return (
    <div className="dashboard">
      <header className="page-head dash-head">
        <div>
          <h1 className="page-title">
            {greeting}, {firstName}
          </h1>
          <p className="page-subtitle">Here's what needs your attention.</p>
        </div>
        <div className="dash-clock">
          <span>{new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", year: "numeric" })}</span>
          <strong className="num">{new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</strong>
        </div>
      </header>

      {session.user.isDemo && (
        <a className="dash-demo" href="#approvals">
          <CirclePlay size={22} aria-hidden="true" />
          <span>
            <strong>Start here: run the demo agent.</strong> It makes real sandbox refunds through Handrail so you can watch one get held,
            approve it, and see its retry stopped.
          </span>
          <ArrowRight size={18} aria-hidden="true" />
        </a>
      )}

      <section className="metrics" aria-label="Last 24 hours">
        <Metric
          icon={Clock}
          tone="warn"
          value={summary?.pendingApprovals}
          label="Waiting for approval"
          note={o ? `${o.current.held} held in 24h` : undefined}
          spark={spark("held")}
        />
        <Metric icon={Activity} tone="neutral" value={o?.current.calls} label="Calls in last 24h" trend={o && trend(o.current.calls, o.previous.calls, "up-good")} spark={spark("calls")} />
        <Metric icon={Check} tone="good" value={o?.current.forwarded} label="Sent to PayPal" trend={o && trend(o.current.forwarded, o.previous.forwarded, "up-good")} spark={spark("sent")} />
        <Metric icon={X} tone="bad" value={o?.current.blocked} label="Blocked" trend={o && trend(o.current.blocked, o.previous.blocked, "up-bad")} spark={spark("blocked")} />
        <Metric icon={Copy} tone="info" value={o?.current.duplicates} label="Duplicates stopped" trend={o && trend(o.current.duplicates, o.previous.duplicates, "neutral")} spark={spark("duplicates")} />
        <Metric icon={Webhook} tone="flag" value={summary?.webhooks.flagged} label="Webhook flags" note="Mismatched or unattributed" />
      </section>
      {overall.error && <p className="error">Couldn't load the last 24 hours: {overall.error.message}</p>}

      <div className="dash-row">
        <ActivityChart stats={stats.data} error={stats.error} tool={tool} onTool={setTool} />
        <ConnectionCard calls={calls.data} callsError={calls.error} setup={setup.data} setupError={setup.error} now={now} demo={session.user.isDemo} />
      </div>

      <div className="dash-row dash-row-lists">
        <section className="card dash-card">
          <header className="dash-card-head">
            <h2>
              Pending approvals <span className="count-badge count-warn">{pending.data?.length ?? 0}</span>
            </h2>
            <a className="view-all" href="#approvals">
              View all <ArrowRight size={16} aria-hidden="true" />
            </a>
          </header>
          {pending.error && <p className="error">{pending.error.message}</p>}
          {!pending.data && !pending.error && <p className="muted pad">Loading…</p>}
          {pending.data?.length === 0 && (
            <div className="dash-empty">
              <CircleCheck size={22} aria-hidden="true" />
              <p>
                <strong>Nothing waiting.</strong> Calls a rule holds for a person appear here as they happen.
              </p>
            </div>
          )}
          <ul className="pending-list">
            {[...(pending.data ?? [])]
              .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
              .slice(0, 3)
              .map((a) => (
                <li key={a.id} className="pending-row">
                  <ToolIcon tool={a.tool} size={18} tone="warn" />
                  <div className="pending-main">
                    <p className="pending-title">{toolLabel(a.tool)}</p>
                    <p className="pending-sub">{a.reason}</p>
                    <div className="chip-row">
                      {a.rules.slice(0, 2).map((r) => (
                        <span key={r.ruleId} className="chip">
                          {r.ruleId}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="pending-amount">
                    <strong className="num">{a.amount ? formatMoney(a.amount) : "—"}</strong>
                    <span className={`countdown-line ${countdown(a.expiresAt, now) === "expired" ? "expired" : ""}`}>
                      <Clock size={14} aria-hidden="true" /> {countdown(a.expiresAt, now)}
                    </span>
                  </div>
                  <a className="btn btn-dark" href={`#approvals/${a.id}`}>
                    Review
                  </a>
                </li>
              ))}
          </ul>
        </section>

        <section className="card dash-card">
          <header className="dash-card-head">
            <h2>Recent activity</h2>
            <a className="view-all" href="#activity">
              View all <ArrowRight size={16} aria-hidden="true" />
            </a>
          </header>
          {calls.error && <p className="error">{calls.error.message}</p>}
          {!calls.data && !calls.error && <p className="muted pad">Loading…</p>}
          {calls.data?.length === 0 && <p className="muted pad">No agent calls yet. They appear here as the agent makes them.</p>}
          <ul className="recent-list">
            {calls.data?.slice(0, 5).map((c) => (
              <li key={c.id} className="recent-row">
                <DecisionIcon decision={c.decision} outcome={c.outcome} />
                <div className="recent-main">
                  <p className="recent-title">{toolLabel(c.tool)}</p>
                  <p className="recent-sub">
                    {c.agent_name ?? "Agent"} · {c.capture_id ?? c.order_id ?? `#${c.id}`}
                  </p>
                </div>
                <div className="recent-amount">
                  <strong className="num">{formatMoney(callAmount(c))}</strong>
                  <span>{timeAgo(c.created_at, now)}</span>
                </div>
                <StatusPill status={c.decision === "duplicate" ? "duplicate" : c.outcome} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

type Trend = { text: string; dir: "up" | "down" | "flat"; tone: "good" | "bad" | "neutral" };

/** Change against the previous 24 hours, as a percentage when there's a base to compare with. */
function trend(cur: number, prev: number, sense: "up-good" | "up-bad" | "neutral", fmt: (n: number) => string = String): Trend {
  const dir = cur > prev ? "up" : cur < prev ? "down" : "flat";
  const tone = dir === "flat" || sense === "neutral" ? "neutral" : (dir === "up") === (sense === "up-good") ? "good" : "bad";
  const text = dir === "flat" ? "No change" : prev === 0 ? `${fmt(cur - prev)} more` : `${Math.round((Math.abs(cur - prev) / prev) * 100)}%`;
  return { text, dir, tone };
}

function TrendLine({ t }: { t: Trend }) {
  const Icon = t.dir === "up" ? ArrowUp : t.dir === "down" ? ArrowDown : null;
  return (
    <span className={`trend trend-${t.tone}`} title="Compared with the previous 24 hours">
      {Icon && <Icon size={14} aria-hidden="true" />}
      {t.dir === "down" && <span className="sr-only">down </span>}
      {t.text}
    </span>
  );
}

function Metric({
  icon: Icon,
  tone,
  value,
  label,
  trend: t,
  note,
  spark,
}: {
  icon: LucideIcon;
  tone: string;
  value: number | undefined;
  label: string;
  trend?: Trend | null;
  note?: string;
  spark?: number[];
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <span className="metric-icon" aria-hidden="true">
        <Icon size={20} strokeWidth={2.2} />
      </span>
      <div className="metric-body">
        <span className="metric-value num">{value ?? "–"}</span>
        <span className="metric-label">{label}</span>
        {t ? <TrendLine t={t} /> : note ? <span className="trend trend-neutral">{note}</span> : null}
      </div>
      {spark && <Sparkline values={spark} tone={tone} />}
    </div>
  );
}

/** A "nice" axis maximum: 3 equal steps of 1, 2 or 5 × 10^n. */
function axisMax(max: number): number {
  const raw = Math.max(1, max) / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return Math.max(3, step * 3);
}

const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric" });

function ActivityChart({ stats, error, tool, onTool }: { stats: ActivityStats | null; error: Error | null; tool: string; onTool: (t: string) => void }) {
  const buckets = stats?.buckets ?? [];
  const max = axisMax(Math.max(0, ...buckets.map((b) => b.calls)));
  const total = stats?.current.calls ?? 0;
  const busiest = buckets.reduce<(typeof buckets)[number] | null>((m, b) => (!m || b.calls > m.calls ? b : m), null);
  const m = stats?.moneyOut;
  const pm = stats?.previousMoneyOut;
  const currency = m?.total[0]?.currency ?? "USD";
  const sumIn = (list: Array<{ currency: string; hundredths: number }> | undefined) => list?.find((x) => x.currency === currency)?.hundredths ?? 0;

  return (
    <section className="chart-card">
      <header className="chart-head">
        <h2>In the last 24 hours</h2>
        <label className="dark-select">
          <span className="sr-only">Show</span>
          <select value={tool} onChange={(e) => onTool(e.target.value)}>
            {TOOLS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="chart-body">
        <div
          className="bars"
          role="img"
          aria-label={
            stats
              ? `${total} agent call${total === 1 ? "" : "s"} in the last 24 hours${busiest && busiest.calls > 0 ? `; busiest hour ${hourLabel(busiest.start)} with ${busiest.calls}` : ""}.`
              : "Loading"
          }
        >
          <div className="bars-axis" aria-hidden="true">
            {[max, (max * 2) / 3, max / 3, 0].map((v) => (
              <span key={v}>{Math.round(v)}</span>
            ))}
          </div>
          <div className="bars-plot">
            <div className="bars-grid" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="bars-cols">
              {buckets.map((b) => (
                <span
                  key={b.start}
                  className="bar"
                  title={`${hourLabel(b.start)}: ${b.calls} call${b.calls === 1 ? "" : "s"} · ${b.sent} sent · ${b.held} held · ${b.blocked} blocked`}
                >
                  <span style={{ height: `${(b.calls / max) * 100}%` }} />
                </span>
              ))}
            </div>
            {stats && total === 0 && <p className="bars-empty">No agent calls in the last 24 hours.</p>}
            {error && <p className="bars-empty">Couldn't load activity: {error.message}</p>}
            <div className="bars-x" aria-hidden="true">
              {buckets.map((b) => (
                <span key={b.start}>{new Date(b.start).getHours() % 4 === 0 ? hourLabel(b.start) : ""}</span>
              ))}
            </div>
          </div>
        </div>
        <dl className="money-out">
          <MoneyRow icon={CreditCard} label="Sent to PayPal" value={m ? formatMoneyList(m.total) : "–"} cur={sumIn(m?.total)} prev={sumIn(pm?.total)} currency={currency} />
          <MoneyRow
            icon={Undo2}
            label={`Refunds${m ? ` (${m.refunds.count})` : ""}`}
            value={m ? formatMoneyList(m.refunds.amounts, currency) : "–"}
            cur={sumIn(m?.refunds.amounts)}
            prev={sumIn(pm?.refunds.amounts)}
            currency={currency}
          />
          <MoneyRow
            icon={CreditCard}
            label={`Captures${m ? ` (${m.captures.count})` : ""}`}
            value={m ? formatMoneyList(m.captures.amounts, currency) : "–"}
            cur={sumIn(m?.captures.amounts)}
            prev={sumIn(pm?.captures.amounts)}
            currency={currency}
          />
          <MoneyRow icon={Gavel} label="Disputes conceded" value={m ? String(m.disputes.count) : "–"} cur={m?.disputes.count ?? 0} prev={pm?.disputes.count ?? 0} />
        </dl>
      </div>
    </section>
  );
}

function MoneyRow({
  icon: Icon,
  label,
  value,
  cur,
  prev,
  currency,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  cur: number;
  prev: number;
  /** Set when cur and prev are amounts in hundredths. */
  currency?: string;
}) {
  const fmt = currency ? (hundredths: number) => formatMoney({ currency, hundredths }) : String;
  return (
    <div className="money-row">
      <dt>
        <Icon size={17} aria-hidden="true" />
        {label}
      </dt>
      <dd>
        <span className="num">{value}</span>
        <TrendLine t={trend(cur, prev, "neutral", fmt)} />
      </dd>
    </div>
  );
}

/**
 * Whether an agent is actually reaching PayPal through Handrail. Only recent
 * calls count as "connected": a key existing doesn't mean anything uses it.
 */
function ConnectionCard({
  calls,
  callsError,
  setup,
  setupError,
  now,
  demo,
}: {
  calls: CallRow[] | null;
  callsError: Error | null;
  setup: SetupChecklist | null;
  setupError: Error | null;
  now: number;
  demo: boolean;
}) {
  const last = calls?.[0];
  const keys = setup?.items.find((i) => i.id === "agents-use-keys");
  const done = setup?.items.filter((i) => i.ok).length;
  let state: "checking" | "error" | "connected" | "quiet" | "ready" | "none";
  if (!calls && !setup) state = callsError || setupError ? "error" : "checking";
  else if (last && now - Date.parse(last.created_at) < 24 * 3600 * 1000) state = "connected";
  else if (last) state = "quiet";
  else if (keys?.ok) state = "ready";
  else state = "none";

  const copy: Record<typeof state, [string, ReactNode]> = {
    checking: ["Checking your agent's connection…", "Looking at recent calls and the setup checklist."],
    error: ["Couldn't check the connection", (callsError ?? setupError)?.message ?? "Try again in a moment."],
    connected: [
      "Your agent is connected",
      <>
        Last call {last && timeAgo(last.created_at, now)}
        {last?.agent_name ? ` from ${last.agent_name}` : ""}. Calls are routed through Handrail and checked against your rules.
      </>,
    ],
    quiet: ["No agent calls in the last 24 hours", <>The last call was {last && timeAgo(last.created_at, now)}. Check the agent is still pointed at Handrail.</>],
    ready: ["Agent key ready, no calls yet", "Point your agent's PayPal MCP server at Handrail with its key. Calls will show up here."],
    none: ["No agent connected yet", "Create an agent key and point your agent at Handrail instead of PayPal."],
  };
  const [title, body] = copy[state];
  return (
    <section className={`connect-card-dash connect-${state}`}>
      <div className="connect-art" aria-hidden="true" />
      <span className="env-chip">
        <span className="env-dot" aria-hidden="true" />
        Sandbox mode
      </span>
      <h2>{title}</h2>
      <p>{body}</p>
      <div className="connect-actions">
        <a className="btn btn-dark btn-pill" href={demo ? "#approvals" : "#setup"}>
          {demo ? "Run the demo agent" : "View setup"} <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
      {setup && (
        <a className="connect-status" href="#setup">
          <span className={`dot ${done === setup.items.length ? "dot-good" : "dot-warn"}`} aria-hidden="true" />
          {done} of {setup.items.length} setup checks done
        </a>
      )}
    </section>
  );
}

function DecisionIcon({ decision, outcome }: { decision: string; outcome: string | null }) {
  const [Icon, tone]: [LucideIcon, string] =
    decision === "duplicate"
      ? [Copy, "info"]
      : decision === "block" || outcome === "blocked"
        ? [Ban, "bad"]
        : outcome === "held" || outcome === "expired"
          ? [Clock, "warn"]
          : outcome === "failed" || outcome === "unknown"
            ? [X, "bad"]
            : [Check, "good"];
  return (
    <span className={`decision-icon tone-${tone}`} aria-hidden="true">
      <Icon size={17} strokeWidth={2.4} />
    </span>
  );
}
