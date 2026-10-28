import { ArrowRight, Bot, Check, ChevronRight, CirclePlay, Code, FileText, KeyRound, Landmark, Lightbulb, ShieldCheck, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, ApiError, can, type Session, type SetupChecklist, type SetupItem } from "../api";
import { CopyButton, Logo, PageHeader, usePoll } from "../components";
import { timeAgo } from "../format";

interface TestCall {
  tool: string;
  ok: boolean;
  callId: number | null;
  decision: string | null;
  outcome: string | null;
  durationMs: number;
  /** PayPal's answer, shortened. */
  detail: string | null;
}

/**
 * Connecting an agent, registering webhooks, and the checklist that makes
 * Handrail the only way to PayPal. Handrail checks what it can; the items
 * about the agent's own environment only a person can confirm (admins,
 * recorded in the audit log).
 */
export function SetupView({ session, title, subtitle }: { session: Session; title: string; subtitle: string }) {
  const setup = usePoll(() => api<SetupChecklist>(session, "/setup"), 15000);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = can(session, "admin");
  const now = Date.now();

  async function confirm(item: SetupItem, confirmed: boolean) {
    setError(null);
    try {
      await api(session, `/setup/${item.id}`, { method: "POST", body: { confirmed } });
      setup.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const header = (
    <PageHeader
      title={title}
      subtitle={subtitle}
      actions={
        <a className="btn btn-secondary btn-lg" href="/#connect">
          <Code size={18} aria-hidden="true" />
          Drop-in code for your framework
        </a>
      }
    />
  );
  if (setup.error && !setup.data)
    return (
      <>
        {header}
        <p className="error">{setup.error.message}</p>
      </>
    );
  if (!setup.data)
    return (
      <>
        {header}
        <p className="muted">Loading…</p>
      </>
    );

  const { items, mcpUrl, webhookUrl } = setup.data;
  const byId = new Map(items.map((i) => [i.id, i]));
  const manual = items.filter((i) => i.kind === "confirm");
  const done = items.filter((i) => i.ok).length;
  const pct = Math.round((done / items.length) * 100);
  const connected = byId.get("agents-use-keys");
  const webhooks = byId.get("webhooks");
  const bypass = byId.get("no-unattributed");

  return (
    <>
      {header}
      <div className="setup-layout">
        <div className="setup-main">
          <section className="card setup-card">
            <StepHead n={1} title="Connect your agent" status={connected} text="Point the agent's PayPal MCP configuration at Handrail. It sees the same tools, with no code changes." />
            <FlowDiagram />
            <div className="copy-fields">
              <CopyField label="MCP endpoint" value={mcpUrl} />
              <CopyField label="Authorization header" value="Authorization: Bearer <agent key>" display={<>Authorization: Bearer &lt;agent key&gt;</>} />
            </div>
            <p className="fine">
              Give the agent an agent key, never PayPal credentials.{" "}
              {isAdmin ? (
                <a href="#team">Create agent keys in Team &amp; keys</a>
              ) : (
                "An admin creates agent keys."
              )}
              . Framework users (LangChain, CrewAI, Vercel AI SDK) can swap PayPal's toolkit for Handrail's drop-in: see the{" "}
              <a href="/#connect">before and after code</a>.
            </p>
            {isAdmin && <TestCallButton session={session} onDone={setup.refresh} />}
          </section>

          <section className="card setup-card">
            <StepHead n={2} title="Register PayPal webhooks" status={webhooks} text="So Handrail can match PayPal's events to agent calls, and catch money that moved without going through it." />
            <div className="copy-fields">
              <CopyField label="Webhook URL" value={webhookUrl} />
            </div>
            <ol className="mini-steps">
              <li>
                <span className="num">1</span>
                <div>
                  <p className="mini-title">Add the webhook in PayPal</p>
                  <p>In the PayPal developer dashboard, open your sandbox app and add a webhook with the URL above.</p>
                </div>
              </li>
              <li>
                <span className="num">2</span>
                <div>
                  <p className="mini-title">Pick the events</p>
                  <p>At least refunds, dispute resolutions, invoice cancellations and subscription cancellations.</p>
                </div>
              </li>
              <li>
                <span className="num">3</span>
                <div>
                  <p className="mini-title">Tell Handrail its id</p>
                  <p>Set PAYPAL_WEBHOOK_ID in Handrail's environment and restart, so signatures are verified.</p>
                </div>
              </li>
            </ol>
            {bypass && <StatusLine item={bypass} />}
          </section>

          <section className="card setup-card">
            <StepHead
              n={3}
              title="Make Handrail the only way to PayPal"
              status={manual.every((i) => i.ok) ? { ok: true } : { ok: false }}
              text="Handrail only protects calls that go through it. An agent that also has PayPal credentials, or a direct PayPal connection, can skip every rule."
            />
            {error && <p className="error">{error}</p>}
            <ul className="confirm-list">
              {manual.map((item) => (
                <li key={item.id} className={item.ok ? "is-ok" : ""}>
                  <span className={`check-dot ${item.ok ? "ok" : ""}`} aria-hidden="true">
                    {item.ok && <Check size={15} strokeWidth={3} />}
                  </span>
                  <div>
                    <p className="check-label">{item.label}</p>
                    <p className="check-detail">{item.detail}</p>
                    {item.ok && item.confirmedBy && (
                      <p className="fine">
                        Confirmed by {item.confirmedBy}
                        {item.confirmedAt && ` ${timeAgo(item.confirmedAt, now)}`}
                      </p>
                    )}
                  </div>
                  {isAdmin && (
                    <button type="button" className={`btn ${item.ok ? "btn-ghost" : "btn-secondary"}`} onClick={() => void confirm(item, !item.ok)}>
                      {item.ok ? "Undo" : "Confirm"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!isAdmin && <p className="fine">Only an admin can confirm these. Confirmations are recorded in the audit log.</p>}
          </section>
        </div>

        <aside className="setup-side">
          <section className="card setup-progress">
            <h2>Setup progress</h2>
            <p>
              {done} of {items.length} checks done
            </p>
            <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
              <span style={{ width: `${pct}%` }} />
            </div>
            <ul className="progress-list">
              {items.map((item) => (
                <li key={item.id}>
                  <span className={`check-dot ${item.ok ? "ok" : item.kind === "auto" ? "warn" : ""}`} aria-hidden="true">
                    {item.ok ? <Check size={14} strokeWidth={3} /> : item.kind === "auto" ? <X size={13} strokeWidth={3} /> : null}
                  </span>
                  <div>
                    <p className="check-label">{item.label}</p>
                    <p className="check-detail">
                      {item.kind === "auto" ? "Checked by Handrail" : item.ok ? "Confirmed" : "Needs an admin to confirm"}
                      {item.kind === "auto" && !item.ok && `: ${item.detail}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card setup-help">
            <h2>Where to look next</h2>
            <HelpLink href="/#connect" icon={Code} title="Drop-in code" text="Before and after for MCP, LangChain, CrewAI and the AI SDK" />
            {isAdmin && <HelpLink href="#team" icon={KeyRound} title="Agent keys" text="Create, see and revoke the keys agents use" />}
            <HelpLink href="#activity" icon={FileText} title="Activity" text="Every call your agents make, and what Handrail decided" />
            <HelpLink href="#audit" icon={ShieldCheck} title="Audit log" text="The tamper-evident record, and its integrity check" />
          </section>

          <section className="setup-tip">
            <Lightbulb size={20} aria-hidden="true" />
            <div>
              <p className="setup-tip-title">Sandbox only</p>
              <p>Handrail is connected to PayPal's sandbox, so you can try every rule and approval without moving real money.</p>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

function StepHead({ n, title, text, status }: { n: number; title: string; text: string; status?: { ok: boolean } }) {
  return (
    <header className="step-head">
      <span className={`step-num ${status?.ok ? "ok" : ""}`} aria-hidden="true">
        {status?.ok ? <Check size={18} strokeWidth={3} /> : n}
      </span>
      <div>
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
      {status && <span className={`step-status ${status.ok ? "ok" : "todo"}`}>{status.ok ? "Done" : "To do"}</span>}
    </header>
  );
}

function StatusLine({ item }: { item: SetupItem }) {
  return (
    <p className={`status-line ${item.ok ? "ok" : "warn"}`}>
      <span className={`check-dot ${item.ok ? "ok" : "warn"}`} aria-hidden="true">
        {item.ok ? <Check size={13} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
      </span>
      <span>
        <strong>{item.label}.</strong> {item.detail}
      </span>
    </p>
  );
}

function CopyField({ label, value, display }: { label: string; value: string; display?: ReactNode }) {
  return (
    <div className="copy-field">
      <span className="copy-field-label">{label}</span>
      <div className="copy-field-row">
        <code>{display ?? value}</code>
        <CopyButton text={value} label="Copy" className="icon-btn icon-btn-plain copy-icon" />
      </div>
    </div>
  );
}

function HelpLink({ href, icon: Icon, title, text }: { href: string; icon: typeof Code; title: string; text: string }) {
  return (
    <a className="help-link" href={href}>
      <span className="help-link-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span>
        <span className="help-link-title">{title}</span>
        <span className="help-link-text">{text}</span>
      </span>
      <ChevronRight size={18} aria-hidden="true" />
    </a>
  );
}

/** Agent → Handrail → PayPal: what goes where. */
function FlowDiagram() {
  return (
    <div className="flow" aria-label="Your agent calls Handrail with an agent key; Handrail checks each call and forwards allowed ones to PayPal; PayPal's webhooks come back to Handrail.">
      <div className="flow-node">
        <span className="flow-icon" aria-hidden="true">
          <Bot size={26} />
        </span>
        <p className="flow-title">Your agent</p>
        <p className="flow-sub">Agent key only</p>
      </div>
      <div className="flow-arrows" aria-hidden="true">
        <span>Tool calls</span>
        <span className="flow-line flow-right" />
        <span className="flow-line flow-left" />
        <span>Results</span>
      </div>
      <div className="flow-node flow-node-brand">
        <Logo size={44} />
        <p className="flow-title">Handrail</p>
        <p className="flow-sub">Policy, approvals, idempotency, audit log</p>
      </div>
      <div className="flow-arrows" aria-hidden="true">
        <span>Allowed calls</span>
        <span className="flow-line flow-right" />
        <span className="flow-line flow-left" />
        <span>Webhooks</span>
      </div>
      <div className="flow-node">
        <span className="flow-icon" aria-hidden="true">
          <Landmark size={26} />
        </span>
        <p className="flow-title">PayPal</p>
        <p className="flow-sub">Sandbox REST and MCP</p>
      </div>
    </div>
  );
}

/** Admin only: one read-only call (list one product) through the gate, recorded in Activity like any agent call. */
function TestCallButton({ session, onDone }: { session: Session; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestCall | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<TestCall>(session, "/setup/test-call", { method: "POST" }));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`test-call ${result ? (result.ok ? "ok" : "bad") : ""}`}>
      <div className="test-call-text">
        {result ? (
          <>
            <p className="test-call-title">{result.ok ? "Handrail reached PayPal" : "The test call didn't succeed"}</p>
            <p>
              <code>{result.tool}</code>{" "}
              {result.ok ? "succeeded" : `ended as ${result.outcome ?? result.decision ?? "unknown"}`} in {result.durationMs} ms
              {result.callId !== null && <> · call #{result.callId}</>}.{" "}
              {!result.ok && result.detail && (
                <>
                  PayPal answered: <code className="test-call-detail">{result.detail}</code>{" "}
                </>
              )}
              <a href="#activity">
                See it in Activity <ArrowRight size={13} aria-hidden="true" />
              </a>
            </p>
          </>
        ) : (
          <>
            <p className="test-call-title">Send a test call</p>
            <p>One read-only call (list one product) through Handrail to PayPal's sandbox. It's checked by the policy and recorded like any agent call.</p>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <button type="button" className="btn btn-dark btn-lg" onClick={() => void run()} disabled={busy}>
        <CirclePlay size={18} aria-hidden="true" />
        {busy ? "Sending…" : result ? "Send again" : "Send test call"}
      </button>
    </div>
  );
}
