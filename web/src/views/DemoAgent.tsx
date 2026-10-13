import { useState } from "react";
import { api, ApiError, type DemoStatus, type DemoStepStatus, type Session } from "../api";
import { usePoll } from "../components";

const STEP_ICON: Record<DemoStepStatus, string> = { waiting: "", running: "", done: "✓", unexpected: "!", failed: "✕" };

/**
 * For the demo account: runs a scripted agent through Handrail against
 * PayPal's sandbox, so a judge can watch an allowed refund, a held one, a
 * deduplicated retry and split refunds caught by a running total, without
 * wiring up an agent of their own.
 */
export function DemoAgentPanel({ session, onActivity }: { session: Session; onActivity: () => void }) {
  const status = usePoll(() => api<DemoStatus>(session, "/demo/run"), 1500);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const s = status.data;
  const run = s?.run ?? null;
  const running = run?.status === "running";
  const wait = s?.nextRunInSeconds ?? 0;

  async function start() {
    setStarting(true);
    setError(null);
    try {
      await api<DemoStatus>(session, "/demo/run", { method: "POST" });
      status.refresh();
      onActivity();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const approval = s?.approval;
  const large = run?.plan.large;
  return (
    <section className="card demo-agent" aria-live="polite">
      <div className="demo-agent-head">
        <div>
          <h2 className="section-title">Demo agent</h2>
          <p className="section-help">
            A scripted support agent connects to Handrail with its own key ("Demo agent") and refunds real sandbox sales: one small
            refund, one over the policy's limit, a retry of that one, then three small refunds on another sale that together pass the
            per-payment total. Everything goes through the same gateway a real agent uses.
          </p>
        </div>
        <button className="btn btn-primary" onClick={start} disabled={starting || running || wait > 0}>
          {running ? "Agent running…" : starting ? "Starting…" : wait > 0 ? `Run again in ${wait}s` : run ? "Run demo agent again" : "Run demo agent"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}

      {run && (
        <ol className="demo-steps">
          {run.steps.map((step) => (
            <li key={step.id} className={`demo-step demo-step-${step.id} demo-step-${step.status}`}>
              <span className="demo-step-icon" aria-hidden="true">
                {step.status === "running" ? <span className="spinner" /> : STEP_ICON[step.status]}
              </span>
              <div>
                <p className="demo-step-title">{step.title}</p>
                <p className="demo-step-text">{step.outcome ?? step.expect}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {run && approval?.status === "pending" && (
        <p className="notice">
          The {large} USD refund is waiting for you below. Read the AI brief, then approve or reject it.
          {running && " The agent is waiting too, and will retry while it does."}
        </p>
      )}
      {run && approval && (approval.status === "executed" || approval.status === "failed") && (
        <p className="notice">
          {approval.decidedBy} approved the {large} USD refund and Handrail sent it to PayPal once, although the agent asked twice. See
          the Activity and Audit log tabs for the record.
        </p>
      )}
      {run && approval?.status === "rejected" && (
        <p className="notice">{approval.decidedBy} rejected the {large} USD refund. The agent was told no, and PayPal never saw it.</p>
      )}
      {run?.error && <p className="error">The demo agent stopped: {run.error}</p>}
      <p className="fine">
        This is your own demo workspace: other visitors can't see it, and it's cleared after {s?.resetsAfterMinutes ?? 120} minutes
        without use. Each run starts fresh, and the agent can run once a minute.
      </p>
    </section>
  );
}
