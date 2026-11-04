import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  FileText,
  Inbox,
  Quote,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, can, type AlertInfo, type Approval, type Money, type Session, type VerifiedFacts } from "../api";
import { DecisionPill, Empty, JsonBlock, Mono, PageHeader, StatusPill, ToolIcon, useNow, usePoll } from "../components";
import { countdown, formatMoney, paypalSummary, timeAgo, toolLabel } from "../format";
import { AiBrief } from "./AiBrief";
import { DemoAgentPanel, DemoRunButton, useDemoAgent } from "./DemoAgent";

/** The ids worth showing. The agent's free text (notes, reasons) goes under "Agent says". */
const KEY_ARGS: Array<[string, string]> = [
  ["capture_id", "Capture ID"],
  ["id", "PayPal ID"],
  ["order_id", "Order ID"],
  ["dispute_id", "Dispute ID"],
  ["invoice_id", "Invoice ID"],
  ["subscription_id", "Subscription ID"],
];

function keyArgs(args: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [key, label] of KEY_ARGS) {
    const v = args[key];
    if (typeof v === "string" || typeof v === "number") rows.push([label, String(v)]);
  }
  return rows;
}

const primaryId = (a: Approval) => keyArgs(a.args)[0]?.[1] ?? a.id;

type View = "waiting" | "decided" | "expired";
type Sort = "urgency" | "newest" | "amount";

/** Whether an approval matches the top bar's search: amount, agent, customer, rule, ids or reason. */
function matches(a: Approval, q: string): boolean {
  if (!q) return true;
  const hay = [
    a.id,
    a.tool,
    toolLabel(a.tool),
    a.amount && formatMoney(a.amount),
    a.amount && (a.amount.hundredths / 100).toFixed(2),
    a.agent?.name,
    a.payee,
    a.reason,
    a.verified?.payer?.name,
    a.verified?.payer?.email,
    ...a.rules.map((r) => r.ruleId),
    ...keyArgs(a.args).map(([, v]) => v),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

export function ApprovalsView({
  session,
  onChange,
  focus,
  search,
  title,
  subtitle,
}: {
  session: Session;
  onChange: () => void;
  focus: string | null;
  search: string;
  title: string;
  subtitle: string;
}) {
  const pending = usePoll(() => api<Approval[]>(session, "/approvals?status=pending"), 2000);
  const all = usePoll(() => api<Approval[]>(session, "/approvals"), 5000);
  const now = useNow();
  const [view, setView] = useState<View>("waiting");
  const [sort, setSort] = useState<Sort>("urgency");
  const [toolFilter, setToolFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(focus);
  // Calls being decided stay on screen until their result has been shown,
  // even though the next poll no longer lists them as pending.
  const [deciding, setDeciding] = useState<Approval[]>([]);

  const refresh = () => {
    pending.refresh();
    all.refresh();
    onChange();
  };
  // isDemo never changes for a session, so this hook is always called (or never) for this component.
  const demo = session.user.isDemo ? useDemoAgent(session, refresh) : null;

  const waiting = [...(pending.data ?? [])];
  for (const a of deciding) if (!waiting.some((c) => c.id === a.id)) waiting.push(a);
  const allList = all.data ?? [];
  const decided = allList.filter((a) => a.status !== "pending" && a.status !== "expired");
  const expired = allList.filter((a) => a.status === "expired");
  const lists: Record<View, Approval[]> = { waiting, decided, expired };

  // An alert link (#approvals/<id>): show that call, on whichever list it's in now.
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    if (!focus) return;
    setSelected(focus);
    if (pending.data?.some((a) => a.id === focus)) return setView("waiting");
    const found = all.data?.find((a) => a.id === focus);
    if (found) return setView(found.status === "expired" ? "expired" : "decided");
    if (all.data) setNotFound(true);
  }, [focus, pending.data, all.data]);

  const tools = [...new Set(lists[view].map((a) => a.tool))].sort();
  const shown = useMemo(() => {
    const list = lists[view].filter((a) => (!toolFilter || a.tool === toolFilter) && matches(a, search.trim()));
    const by: Record<Sort, (a: Approval, b: Approval) => number> = {
      urgency: (a, b) =>
        view === "waiting" ? Date.parse(a.expiresAt) - Date.parse(b.expiresAt) : Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt),
      newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      amount: (a, b) => (b.amount?.hundredths ?? -1) - (a.amount?.hundredths ?? -1),
    };
    return list.sort(by[sort]);
  }, [lists[view], toolFilter, search, sort, view]);

  const current = shown.find((a) => a.id === selected) ?? allList.find((a) => a.id === selected && view !== "waiting") ?? shown[0] ?? null;
  const loaded = view === "waiting" ? pending.data !== null : all.data !== null;
  const error = view === "waiting" ? pending.error : all.error;

  return (
    <div className="approvals-page">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {demo && <DemoRunButton demo={demo} />}
            <button className="btn btn-secondary btn-lg" onClick={refresh}>
              <RefreshCw size={17} aria-hidden="true" /> Refresh
            </button>
          </>
        }
      />
      {demo && <DemoAgentPanel demo={demo} />}
      {notFound && focus && !current && (
        <p className="notice notice-warn">This held call wasn't found. It may belong to another workspace, or the link is wrong.</p>
      )}

      <div className="review">
        <section className="queue" aria-label="Approval queue">
          <div className="seg-tabs" role="tablist">
            {(
              [
                ["waiting", "Waiting for you", waiting.length],
                ["decided", "Recently decided", decided.length],
                ["expired", "Expired", expired.length],
              ] as const
            ).map(([v, label, n]) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                className={`seg-tab ${view === v ? "active" : ""}`}
                onClick={() => {
                  setView(v);
                  setToolFilter("");
                  setSelected(null);
                }}
              >
                {label}
                <span className={`count-badge ${v === "waiting" && n > 0 ? "count-warn" : ""}`}>{n}</span>
              </button>
            ))}
          </div>

          <div className="queue-tools">
            <label className="select-pill">
              <span>Sort:</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="urgency">{view === "waiting" ? "Urgency" : "Most recent"}</option>
                <option value="newest">Requested (newest)</option>
                <option value="amount">Amount (highest)</option>
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </label>
            <label className="select-pill">
              <span className="sr-only">Action</span>
              <select value={toolFilter} onChange={(e) => setToolFilter(e.target.value)}>
                <option value="">All actions</option>
                {tools.map((t) => (
                  <option key={t} value={t}>
                    {toolLabel(t)}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </label>
          </div>

          {error && <p className="error">{error.message}</p>}
          {!loaded && !error && <p className="muted pad">Loading…</p>}
          {loaded && shown.length === 0 && (
            <Empty title={search || toolFilter ? "No matches" : view === "waiting" ? "Nothing to review" : view === "decided" ? "No decisions yet" : "Nothing expired"}>
              {search || toolFilter
                ? "Try a different search or action."
                : view === "waiting"
                  ? "Calls that a policy holds for a human will appear here as they happen."
                  : view === "decided"
                    ? "Approved and rejected calls appear here."
                    : "Held calls nobody decided in time appear here. They were never sent to PayPal."}
            </Empty>
          )}
          <ul className="queue-list">
            {shown.map((a) => (
              <li key={a.id}>
                <button className={`queue-item ${current?.id === a.id ? "selected" : ""}`} onClick={() => setSelected(a.id)} aria-current={current?.id === a.id}>
                  <ToolIcon tool={a.tool} size={18} tone={view === "waiting" ? "warn" : undefined} />
                  <span className="queue-main">
                    <span className="queue-title">{toolLabel(a.tool)}</span>
                    <span className="queue-sub">
                      <span className="queue-id">{primaryId(a)}</span> · {a.agent?.name ?? "Agent"}
                    </span>
                    <span className="chip-row">
                      {a.rules.slice(0, 2).map((r) => (
                        <span key={r.ruleId} className="chip">
                          {r.ruleId}
                        </span>
                      ))}
                    </span>
                  </span>
                  <span className="queue-right">
                    <span className="queue-amount num">{a.amount ? formatMoney(a.amount) : "—"}</span>
                    {a.status === "pending" ? (
                      <span className={`countdown-line ${countdown(a.expiresAt, now) === "expired" ? "expired" : ""}`}>
                        <Clock size={14} aria-hidden="true" /> {countdown(a.expiresAt, now)}
                      </span>
                    ) : (
                      <StatusPill status={a.status} />
                    )}
                  </span>
                  <ChevronRight size={18} className="queue-chevron" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className={`review-detail ${current ? "" : "is-empty"}`} aria-label="Selected call">
          {current ? (
            <ApprovalDetail
              key={current.id}
              approval={current}
              session={session}
              now={now}
              onDeciding={() => setDeciding((d) => [...d, current])}
              onDecided={() => {
                setDeciding((d) => d.filter((x) => x.id !== current.id));
                setSelected(null);
                refresh();
              }}
            />
          ) : (
            <div className="detail-empty">
              <Inbox size={28} aria-hidden="true" />
              <p>{loaded ? "Select a call to review it." : "Loading…"}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const money = (hundredths: number, currency: string) => formatMoney({ hundredths, currency });
const PER_WORDS = { capture: "this payment", order: "this order", payer: "this customer", agent: "this agent" } as const;

/**
 * Cumulative limits: the running total against its limit, then in a sentence:
 * "$180.00 already refunded on this order (per PayPal); this would bring it to
 * $270.00 of $240.00 paid."
 */
function RunningTotals({ approval: a }: { approval: Approval }) {
  if (!a.totals?.length) return null;
  return (
    <section className="running-total">
      {a.totals.map((t) => (
        <div key={t.ruleId} className="running-total-item">
          <p className="running-total-label">Running total ({PER_WORDS[t.per]})</p>
          <p className="running-total-value">
            <TrendingUp size={22} aria-hidden="true" />
            <strong className="num">{money(t.total, t.currency)}</strong>
            <span className="num"> / {money(t.limit, t.currency)}</span>
          </p>
          <p className="running-total-text">
            {money(t.already, t.currency)} already refunded ({t.source === "paypal" ? "per PayPal" : "per Handrail's log"})
            {t.held > 0 && <>, plus {money(t.held, t.currency)} held for approval</>}; this would bring it to {money(t.total, t.currency)}
            {t.paid !== null && <> of {money(t.paid, t.currency)} paid</>}. {t.total > t.limit ? "That's over the limit." : ""}
          </p>
        </div>
      ))}
    </section>
  );
}

const moneyOr = (m: Money | null | undefined, fallback = "unknown") => (m ? formatMoney(m) : fallback);
const words = (s: string | null | undefined) => s?.toLowerCase().replaceAll("_", " ") ?? null;

/** What PayPal confirmed about the object, looked up before deciding. Never the agent's words. */
export function Verified({ verified: v }: { verified: VerifiedFacts | null }) {
  if (!v) return null;
  const rows: Array<[string, string]> = [];
  if (v.capture) rows.push(["Payment", `${moneyOr(v.capture.amount)} · ${words(v.capture.status) ?? "status unknown"}`]);
  if (v.order) rows.push(["Order", `${v.order.id} · ${moneyOr(v.order.amount)}`]);
  if (v.refunds) rows.push(["Already refunded", `${moneyOr(v.refunds.capture, "nothing")} on this payment · ${moneyOr(v.refunds.order, "nothing")} on the order`]);
  if (v.payer) rows.push(["Payer", [v.payer.name, v.payer.email, v.payer.card].filter(Boolean).join(" · ") || "not identified"]);
  if (v.dispute) {
    rows.push(["Dispute", [moneyOr(v.dispute.amount), words(v.dispute.status) ?? "status unknown", words(v.dispute.reason)].filter(Boolean).join(" · ")]);
    if (v.dispute.respondBy) rows.push(["Respond by", new Date(v.dispute.respondBy).toLocaleString()]);
  }
  if (v.invoice) rows.push(["Invoice", `${moneyOr(v.invoice.amount)} · ${words(v.invoice.status) ?? "status unknown"} · to ${v.invoice.recipient ?? "unknown"}`]);
  if (v.subscription) rows.push(["Subscription", `${words(v.subscription.status) ?? "status unknown"} · plan ${v.subscription.plan ?? "unknown"}`]);
  const failed = v.source === "unavailable";
  return (
    <section className={`verified ${failed ? "verified-failed" : ""}`}>
      <p className="verified-label">{failed ? "Couldn't verify with PayPal" : "Verified with PayPal"}</p>
      {rows.length > 0 && (
        <ul className="verified-rows">
          {rows.map(([k, val]) => (
            <li key={k}>
              {failed ? <CircleAlert size={17} aria-hidden="true" /> : <CircleCheck size={17} aria-hidden="true" />}
              <span className="verified-key">{k}</span>
              <span className="verified-val">{val}</span>
            </li>
          ))}
        </ul>
      )}
      {v.error && <p className="fine">{failed ? `${v.error}. The amount shown is what the agent asked for; nothing else was confirmed.` : `${v.error}.`}</p>}
    </section>
  );
}

const FIELD_WORDS: Record<string, string> = { note_to_payer: "Note to the customer", reason: "Reason", note: "Note" };

/** The agent's own words, quoted and marked unverified. Never shown as fact. */
export function AgentSays({ approval: a }: { approval: Approval }) {
  if (!a.agentSays?.length) return null;
  return (
    <section className="agent-says">
      <Quote size={22} className="agent-says-mark" aria-hidden="true" />
      <div>
        <p className="agent-says-label">Agent says (unverified)</p>
        {a.agentSays.map((c) => (
          <figure key={c.field}>
            <blockquote>“{c.text}”</blockquote>
            <figcaption>
              {FIELD_WORDS[c.field] ?? c.field}, from {a.agent?.name ?? "the agent"}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/** Who was alerted about this held call (or, in a demo, the alert it would have sent). */
function AlertLine({ alert }: { alert: AlertInfo | null }) {
  if (!alert || alert.status === "skipped") return null;
  if (alert.status === "preview" && alert.preview) {
    return (
      <details className="alert-preview">
        <summary>Alert preview (demo: nothing was sent)</summary>
        <p className="alert-preview-subject">{alert.preview.subject}</p>
        <pre>{alert.preview.text}</pre>
      </details>
    );
  }
  if (alert.status === "off") return <p className="alert-line alert-line-off">Alerts are off, so nobody was notified about this call.</p>;
  if (alert.status === "nobody") return <p className="alert-line alert-line-off">Nobody was alerted: no approver has email alerts on.</p>;
  const parts = [
    alert.emailedTo.length > 0 && `emailed ${alert.emailedTo.join(", ")}${alert.emailFailed ? ` (${alert.emailFailed} failed)` : ""}`,
    alert.slack === "sent" && "posted to Slack",
    alert.slack === "failed" && "Slack failed",
  ].filter(Boolean);
  return <p className={`alert-line ${alert.status === "sent" ? "" : "alert-line-bad"}`}>Alert {parts.join(" · ")}</p>;
}

const dateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function ApprovalDetail({
  approval: a,
  session,
  now,
  onDeciding,
  onDecided,
}: {
  approval: Approval;
  session: Session;
  now: number;
  onDeciding: () => void;
  onDecided: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [outcome, setOutcome] = useState<{ tone: string; text: string } | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollTo?.({ top: 0 });
  }, [a.id]);

  async function decide(action: "approve" | "reject") {
    onDeciding();
    setBusy(action);
    setOutcome(null);
    try {
      const result = await api<Approval>(session, `/approvals/${a.id}/${action}`, { method: "POST", body: { note: note.trim() || undefined } });
      const summary = paypalSummary(result.result);
      setOutcome(
        result.status === "executed"
          ? { tone: "good", text: `Approved and sent to PayPal${summary ? `: ${summary}` : ""}` }
          : result.status === "rejected"
            ? { tone: "bad", text: "Rejected. The agent was told no." }
            : { tone: "bad", text: `${result.status === "blocked" ? "Blocked on re-check" : "PayPal returned an error"}${summary ? `: ${summary}` : ""}` },
      );
      setTimeout(onDecided, 2500);
    } catch (err) {
      setOutcome({ tone: "bad", text: err instanceof ApiError ? err.message : String(err) });
      setTimeout(onDecided, 2500); // still pending (it stays listed) or decided elsewhere (409: it goes)
    } finally {
      setBusy(null);
    }
  }

  const pending = a.status === "pending";
  const left = countdown(a.expiresAt, now);
  const customer = a.verified?.payer ? [a.verified.payer.name, a.verified.payer.email && `(${a.verified.payer.email})`].filter(Boolean).join(" ") : a.payee;
  const idempotencyKey = typeof a.args.idempotency_key === "string" ? a.args.idempotency_key : null;

  return (
    <article ref={ref} className="detail">
      <header className="detail-head">
        <ToolIcon tool={a.tool} size={24} tone={pending ? "warn" : undefined} />
        <div className="detail-title">
          <h2>
            {toolLabel(a.tool)} {pending ? <DecisionPill decision={a.decision} /> : <StatusPill status={a.status} />}
          </h2>
          <p>
            {primaryId(a)} · {a.agent?.name ?? "Agent"} · {dateTime(a.createdAt)}
          </p>
        </div>
        {pending && (
          <div className={`detail-countdown ${left === "expired" ? "expired" : ""}`}>
            <span>
              <Clock size={18} aria-hidden="true" /> {left}
            </span>
            <small>Expires at {new Date(a.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</small>
          </div>
        )}
      </header>

      <div className="detail-grid">
        <div className="detail-main">
          <p className="detail-label">Amount</p>
          {a.amount ? (
            <p className="detail-amount">
              <span className="num">{formatMoney(a.amount)}</span>
              <small>{a.amount.currency}</small>
            </p>
          ) : (
            <p className="detail-amount detail-amount-none">No amount on this call</p>
          )}
          {a.amount && a.amountSource === "lookup" && <p className="hint">Amount looked up from PayPal</p>}

          <div className="held-box">
            <CircleAlert size={22} aria-hidden="true" />
            <div>
              <p className="held-title">Held by rule</p>
              <p>{a.reason}</p>
              {a.rules.length > 0 && (
                <div className="chip-row">
                  {a.rules.map((r) => (
                    <span key={r.ruleId} className={`chip ${r.decision === "block" ? "chip-bad" : "chip-warn"}`}>
                      {r.ruleId}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <dl className="facts">
            <div>
              <dt>Action</dt>
              <dd>
                <Mono>{a.tool}</Mono>
              </dd>
            </div>
            {keyArgs(a.args).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="mono-text">{v}</dd>
              </div>
            ))}
            {customer && (
              <div>
                <dt>Customer</dt>
                <dd>{customer}</dd>
              </div>
            )}
            <div>
              <dt>Agent</dt>
              <dd>{a.agent?.name ?? "Not recorded"}</dd>
            </div>
            {idempotencyKey && (
              <div>
                <dt>Idempotency key</dt>
                <dd className="mono-text">{idempotencyKey}</dd>
              </div>
            )}
            <div>
              <dt>Requested</dt>
              <dd>{timeAgo(a.createdAt, now)}</dd>
            </div>
          </dl>
        </div>

        <div className="detail-side">
          <RunningTotals approval={a} />
          <Verified verified={a.verified} />
        </div>
      </div>

      <AgentSays approval={a} />
      <AiBrief approval={a} />
      <AlertLine alert={a.alert} />

      {outcome ? (
        <p className={`outcome outcome-${outcome.tone}`}>{outcome.text}</p>
      ) : !pending ? (
        <DecidedLine approval={a} now={now} />
      ) : !can(session, "approver") ? (
        <p className="outcome outcome-muted">You're a viewer, so you can see this call but not decide it. An approver or admin decides.</p>
      ) : (
        <div className="decide-bar">
          <label className="note-field">
            <FileText size={18} aria-hidden="true" />
            <input
              placeholder="Add a note (optional), e.g. “Confirmed with the customer”"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy !== null}
              aria-label="Note (optional)"
            />
            <span className="note-count num">{note.length}/500</span>
          </label>
          <button className="btn btn-secondary btn-decide" onClick={() => decide("reject")} disabled={busy !== null}>
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
          <button className="btn btn-dark btn-decide" onClick={() => decide("approve")} disabled={busy !== null}>
            {busy === "approve" ? "Sending to PayPal…" : "Approve"}
          </button>
        </div>
      )}

      <details className="more">
        <summary>
          Additional details <ChevronDown size={18} aria-hidden="true" />
        </summary>
        <dl className="facts">
          <div>
            <dt>Approval id</dt>
            <dd className="mono-text">{a.id}</dd>
          </div>
          {a.explanationModel && (
            <div>
              <dt>Brief written by</dt>
              <dd>{a.explanationModel}</dd>
            </div>
          )}
        </dl>
        {a.rules.length > 0 && (
          <>
            <p className="detail-label">Rules that fired</p>
            <ul className="rule-hits">
              {a.rules.map((r) => (
                <li key={r.ruleId}>
                  <DecisionPill decision={r.decision} /> <Mono>{r.ruleId}</Mono> {r.reason}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="detail-label">Agent's arguments</p>
        <JsonBlock value={a.args} />
        {a.result != null && (
          <>
            <p className="detail-label">PayPal's response</p>
            <JsonBlock value={a.result} />
          </>
        )}
      </details>
    </article>
  );
}

/** What happened to a call that's no longer waiting. */
function DecidedLine({ approval: a, now }: { approval: Approval; now: number }) {
  const summary = a.result != null ? paypalSummary(a.result) : "";
  const tone = a.status === "executed" ? "good" : a.status === "expired" ? "muted" : "bad";
  const text =
    a.status === "expired"
      ? "Nobody decided in time, so it expired. It was not sent to PayPal."
      : a.decidedBy
        ? `${a.status === "rejected" ? "Rejected" : "Approved"} by ${a.decidedBy}${a.decidedAt ? ` ${timeAgo(a.decidedAt, now)}` : ""}${a.note ? `: “${a.note}”` : "."}`
        : "No longer waiting for a decision.";
  return (
    <div className={`outcome outcome-${tone}`}>
      <p>{text}</p>
      {summary && <p className="fine">PayPal: {summary}</p>}
    </div>
  );
}
