import { useEffect, useRef, useState } from "react";
import { api, ApiError, can, type AlertInfo, type Approval, type Session } from "../api";
import { DecisionPill, Empty, Mono, Pill, StatusPill, useNow, usePoll } from "../components";
import { countdown, formatMoney, paypalSummary, timeAgo, toolLabel } from "../format";
import { DemoAgentPanel } from "./DemoAgent";

/** The arguments worth showing on a card, most identifying first. */
const KEY_ARGS = ["capture_id", "id", "order_id", "dispute_id", "invoice_id", "subscription_id", "note_to_payer", "reason", "note"];

function keyArgs(args: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const key of KEY_ARGS) {
    const v = args[key];
    if (typeof v === "string" || typeof v === "number") rows.push([key, String(v)]);
  }
  return rows;
}

export function ApprovalsView({ session, onChange, focus }: { session: Session; onChange: () => void; focus: string | null }) {
  const pending = usePoll(() => api<Approval[]>(session, "/approvals?status=pending"), 2000);
  const all = usePoll(() => api<Approval[]>(session, "/approvals"), 5000);
  const now = useNow();
  // Cards the user is deciding stay on screen until their result has been shown,
  // even though the next poll no longer lists them as pending.
  const [deciding, setDeciding] = useState<Approval[]>([]);

  const refresh = () => {
    pending.refresh();
    all.refresh();
    onChange();
  };
  const cards = [...(pending.data ?? [])];
  for (const a of deciding) if (!cards.some((c) => c.id === a.id)) cards.push(a);
  const decided = (all.data ?? []).filter((a) => a.status !== "pending").slice(0, 15);

  return (
    <div className="approvals">
      {session.user.isDemo && <DemoAgentPanel session={session} onActivity={refresh} />}
      {focus && !cards.some((c) => c.id === focus) && <FocusedApproval session={session} id={focus} now={now} />}
      <section>
        <h2 className="section-title">
          Waiting for you <span className="count">{pending.data?.length ?? 0}</span>
        </h2>
        {pending.error && <p className="error">{pending.error.message}</p>}
        {pending.data && cards.length === 0 && (
          <Empty title="Nothing to review">Calls that a policy holds for a human will appear here as they happen.</Empty>
        )}
        <div className="cards">
          {cards.map((a) => (
            <ApprovalCard
              key={a.id}
              focused={a.id === focus}
              approval={a}
              session={session}
              now={now}
              onDeciding={() => setDeciding((d) => [...d, a])}
              onDecided={() => {
                setDeciding((d) => d.filter((x) => x.id !== a.id));
                refresh();
              }}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-title">Recently decided</h2>
        {decided.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <ul className="decided">
            {decided.map((a) => (
              <li key={a.id}>
                <div className="decided-main">
                  <strong>{toolLabel(a.tool)}</strong>
                  <span className="amount-sm">{formatMoney(a.amount)}</span>
                  <StatusPill status={a.status} />
                </div>
                <div className="decided-meta">
                  {a.decidedBy ? (
                    <>
                      {a.status === "rejected" ? "Rejected" : "Approved"} by <strong>{a.decidedBy}</strong>
                    </>
                  ) : a.status === "expired" ? (
                    "Nobody decided in time"
                  ) : (
                    "No decision"
                  )}
                  {a.decidedAt && ` · ${timeAgo(a.decidedAt, now)}`}
                  {a.note && <> · “{a.note}”</>}
                  {a.result != null && paypalSummary(a.result) && <> · {paypalSummary(a.result)}</>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The AI-written brief. Shown below the rule that held the call, and labelled
 * as advisory: the rules decided to hold it, and only the human decides.
 */
function AiBrief({ approval: a }: { approval: Approval }) {
  const status = a.explanationStatus;
  if (!status || status === "unavailable") return null;
  return (
    <section className="ai" aria-live="polite">
      <header className="ai-head">
        <span className="ai-label">
          <span className="ai-spark" aria-hidden="true">
            ✦
          </span>
          AI brief
        </span>
        <span className="ai-note" title={a.explanationModel ?? undefined}>
          Advisory only. It can't approve anything.
        </span>
      </header>
      {status === "pending" && (
        <div className="ai-loading">
          <span className="shimmer" />
          <span className="shimmer short" />
        </div>
      )}
      {status === "failed" && <p className="muted">Couldn't write a brief this time. The rule above is why it was held.</p>}
      {status === "ready" && a.explanation && (
        <>
          <p className="ai-summary">{a.explanation.summary}</p>
          {a.explanation.concerns.length > 0 && (
            <div className="ai-concerns">
              <p className="ai-sub">Watch out</p>
              <ul>
                {a.explanation.concerns.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {a.explanation.context.length > 0 && (
            <>
              <p className="ai-sub">Context</p>
              <ul className="ai-list">
                {a.explanation.context.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          )}
          <p className="ai-sub">Check before approving</p>
          <ul className="ai-checks">
            {a.explanation.checkBeforeApproving.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The approval an alert linked to, when it's no longer waiting (decided,
 * expired, or not in this workspace): what happened to it.
 */
function FocusedApproval({ session, id, now }: { session: Session; id: string; now: number }) {
  const found = usePoll(() => api<Approval>(session, `/approvals/${id}`), 5000);
  if (!found.data && !found.error) return null;
  const a = found.data;
  if (a?.status === "pending") return null; // shown in the list below, highlighted
  const what = !a
    ? "This held call wasn't found. It may belong to another workspace, or the link is wrong."
    : a.status === "expired"
      ? "Nobody decided in time, so it expired. It was not sent to PayPal."
      : a.decidedBy
        ? `${a.status === "rejected" ? "Rejected" : "Approved"} by ${a.decidedBy}${a.decidedAt ? ` ${timeAgo(a.decidedAt, now)}` : ""}.`
        : "It's no longer waiting for a decision.";
  return (
    <section className="card focused-approval" aria-live="polite">
      <div className="focused-head">
        <p className="card-kicker">From your alert</p>
        {a && <StatusPill status={a.status} />}
      </div>
      {a && (
        <p className="focused-title">
          <strong>{toolLabel(a.tool)}</strong> {formatMoney(a.amount)}
        </p>
      )}
      <p>{what}</p>
      <a className="btn btn-ghost" href="#approvals">
        Show everything waiting
      </a>
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
    alert.emailedTo.length > 0 &&
      `emailed ${alert.emailedTo.join(", ")}${alert.emailFailed ? ` (${alert.emailFailed} failed)` : ""}`,
    alert.slack === "sent" && "posted to Slack",
    alert.slack === "failed" && "Slack failed",
  ].filter(Boolean);
  return (
    <p className={`alert-line ${alert.status === "sent" ? "" : "alert-line-bad"}`}>
      Alert {parts.join(" · ")}
    </p>
  );
}

function ApprovalCard({
  approval: a,
  focused,
  session,
  now,
  onDeciding,
  onDecided,
}: {
  focused?: boolean;
  approval: Approval;
  session: Session;
  now: number;
  onDeciding: () => void;
  onDecided: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [outcome, setOutcome] = useState<{ tone: string; text: string } | null>(null);

  async function decide(action: "approve" | "reject") {
    onDeciding();
    setBusy(action);
    setOutcome(null);
    try {
      const result = await api<Approval>(session, `/approvals/${a.id}/${action}`, {
        method: "POST",
        body: { note: note.trim() || undefined },
      });
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

  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused]);

  const left = countdown(a.expiresAt, now);
  return (
    <article ref={ref} className={`card approval-card ${focused ? "focused" : ""}`}>
      <header className="card-head">
        <div>
          <p className="card-kicker">{toolLabel(a.tool)}</p>
          {a.amount ? (
            <>
              <p className="amount">{formatMoney(a.amount)}</p>
              {a.amountSource === "lookup" && <p className="hint">Amount looked up from PayPal</p>}
            </>
          ) : (
            <p className="hint">No amount on this call</p>
          )}
        </div>
        <div className="card-head-right">
          <DecisionPill decision={a.decision} />
          <span className={`countdown ${left === "expired" ? "expired" : ""}`}>{left}</span>
        </div>
      </header>

      <div className="why">
        <p className="why-label">Why it was held</p>
        <p>{a.reason}</p>
        {a.rules.length > 0 && (
          <div className="chips">
            {a.rules.map((r) => (
              <Pill key={r.ruleId} tone={r.decision === "block" ? "bad" : "warn"}>
                {r.ruleId}
              </Pill>
            ))}
          </div>
        )}
      </div>

      <AiBrief approval={a} />
      <AlertLine alert={a.alert} />

      <dl className="kv">
        {keyArgs(a.args).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              <Mono>{v}</Mono>
            </dd>
          </div>
        ))}
        {a.payee && (
          <div>
            <dt>payee</dt>
            <dd>{a.payee}</dd>
          </div>
        )}
        {a.agent && (
          <div>
            <dt>agent</dt>
            <dd>{a.agent.name}</dd>
          </div>
        )}
        <div>
          <dt>requested</dt>
          <dd>{timeAgo(a.createdAt, now)}</dd>
        </div>
      </dl>

      {outcome ? (
        <p className={`outcome outcome-${outcome.tone}`}>{outcome.text}</p>
      ) : !can(session, "approver") ? (
        <p className="outcome outcome-muted">You're a viewer, so you can see this call but not decide it. An approver or admin decides.</p>
      ) : (
        <div className="decide">
          <input
            className="input"
            placeholder="Note (optional), e.g. “Confirmed with the customer”"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy !== null}
          />
          <div className="decide-buttons">
            <button className="btn btn-secondary" onClick={() => decide("reject")} disabled={busy !== null}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <button className="btn btn-primary" onClick={() => decide("approve")} disabled={busy !== null}>
              {busy === "approve" ? "Sending to PayPal…" : "Approve"}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
