import { useState, type FormEvent } from "react";
import { api, ApiError, can, type Decision, type Policy, type PolicyProposal, type PolicyResponse, type Session } from "../api";
import { DecisionPill, JsonBlock, Mono, usePoll } from "../components";
import { describeRule } from "../format";

const DEFAULT_LABELS: Record<keyof Policy["defaults"], string> = {
  read: "Read-only tools (list, get, search)",
  write: "Other changes (create drafts, update)",
  money: "Money-moving tools no rule matched",
  unknown: "Tools Handrail doesn't recognise",
};

const SEVERITY: Record<Decision, number> = { block: 0, require_approval: 1, allow: 2 };

const EXAMPLES = [
  "Refunds over $250 need my approval",
  "Never let the agent capture more than $2,000 in a day",
  "Block more than 3 subscription cancellations per hour",
  "Invoices to anyone outside @acme.com need approval",
];

export function PolicyView({ session }: { session: Session }) {
  const policy = usePoll(() => api<PolicyResponse>(session, "/policy"), 15000);
  if (policy.error) return <p className="error">{policy.error.message}</p>;
  if (!policy.data) return <p className="muted">Loading…</p>;
  const { data } = policy;

  async function save(next: Policy, source: string): Promise<string | null> {
    try {
      await api(session, "/policy", { method: "PUT", body: { policy: next, baseHash: data.hash, source } });
      policy.refresh();
      return null;
    } catch (err) {
      policy.refresh();
      return err instanceof ApiError ? err.message : String(err);
    }
  }

  async function removeRule(id: string) {
    const rule = data.policy.rules.find((r) => r.id === id);
    if (!rule || !window.confirm(`Remove this rule?\n\n${describeRule(rule)}\n\nThe change is recorded in the audit log.`)) return;
    const error = await save({ ...data.policy, rules: data.policy.rules.filter((r) => r.id !== id) }, `Removed rule ${id}`);
    if (error) window.alert(error);
  }

  const rules = [...data.policy.rules].sort((a, b) => SEVERITY[a.decision] - SEVERITY[b.decision]);
  const isAdmin = can(session, "admin");
  return (
    <div className="policy">
      <p className="lede">
        Enforced by deterministic code on every call. When several rules fire, the strictest wins, and a human can never approve
        past a block. If Handrail can't work out an amount or payee, the call is held rather than guessed.
      </p>

      {isAdmin ? (
        <Composer session={session} enabled={data.ai.enabled} onApply={save} />
      ) : (
        <p className="notice">Only admins can change the policy. You can see every rule that applies.</p>
      )}

      <section className="card">
        <h2 className="section-title">Rules</h2>
        <ul className="rules">
          {rules.map((r) => (
            <li key={r.id} className={isAdmin ? "has-delete" : undefined}>
              <DecisionPill decision={r.decision} />
              <div>
                <p className="rule-text">{describeRule(r)}</p>
                <p className="rule-meta">
                  <Mono>{r.id}</Mono>
                  {r.description && <> · {r.description}</>}
                </p>
              </div>
              {isAdmin && (
                <button className="btn btn-ghost rule-delete" onClick={() => void removeRule(r.id)} aria-label={`Remove ${r.id}`}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <HoldExpiry policy={data.policy} isAdmin={isAdmin} onSave={save} />

      <section className="card">
        <h2 className="section-title">When no rule matches</h2>
        <ul className="rules">
          {(Object.keys(DEFAULT_LABELS) as Array<keyof Policy["defaults"]>).map((k) => (
            <li key={k}>
              <DecisionPill decision={data.policy.defaults[k]} />
              <p className="rule-text">{DEFAULT_LABELS[k]}</p>
            </li>
          ))}
        </ul>
      </section>

      <p className="policy-foot">
        Policy <Mono>{data.hash.slice(0, 12)}</Mono>. Every change is recorded in the audit log with who made it.
      </p>
    </div>
  );
}

/**
 * Plain English in, a proposal out. The AI drafts rules; Handrail validates
 * them and restates them in its own words; nothing applies until confirmed.
 */
function Composer({
  session,
  enabled,
  onApply,
}: {
  session: Session;
  enabled: boolean;
  onApply: (next: Policy, source: string) => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"draft" | "apply" | null>(null);
  const [proposal, setProposal] = useState<PolicyProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  async function draft() {
    setBusy("draft");
    setError(null);
    setProposal(null);
    setApplied(null);
    try {
      setProposal(await api<PolicyProposal>(session, "/policy/compile", { method: "POST", body: { instruction: text } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!proposal) return;
    setBusy("apply");
    const problem = await onApply(proposal.policy, text.trim());
    setBusy(null);
    if (problem) {
      setError(problem);
    } else {
      setApplied(`Applied: ${proposal.sentences.add.concat(proposal.sentences.remove.map((s) => `removed “${s}”`)).join("; ")}`);
      setProposal(null);
      setText("");
    }
  }

  if (!enabled) {
    return (
      <section className="card composer">
        <h2 className="section-title">Write a rule in plain English</h2>
        <p className="muted">Set ANTHROPIC_API_KEY in .env and restart Handrail to draft rules in plain English.</p>
      </section>
    );
  }

  return (
    <section className="card composer">
      <h2 className="section-title">Write a rule in plain English</h2>
      <textarea
        className="input"
        value={text}
        maxLength={1000}
        placeholder="e.g. Refunds over $250 need my approval"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) void draft();
        }}
        disabled={busy !== null}
      />
      <div className="composer-actions">
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="example" onClick={() => setText(ex)} disabled={busy !== null}>
              {ex}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => void draft()} disabled={busy !== null || !text.trim()}>
          {busy === "draft" ? "Drafting…" : "Draft rules"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {applied && <p className="outcome outcome-good">{applied}</p>}

      {proposal?.question && (
        <p className="question">
          {proposal.question} <span className="muted">Add the detail above and draft again.</span>
        </p>
      )}

      {proposal && !proposal.question && (
        <div className="proposal">
          <p className="proposal-title">Handrail will change the policy like this:</p>
          <ul className="change-list">
            {proposal.add.map((r, i) => (
              <li key={r.id} className="change-add">
                <span className="change-sign">+</span>
                <DecisionPill decision={r.decision} />
                <span>{proposal.sentences.add[i]?.replace(/ → .*$/, "")}</span>
              </li>
            ))}
            {proposal.sentences.remove.map((s, i) => (
              <li key={proposal.remove[i]} className="change-remove">
                <span className="change-sign">−</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
          {proposal.warnings.length > 0 && (
            <ul className="warnings">
              {proposal.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {proposal.assumptions.length > 0 && (
            <>
              <p className="ai-sub">The AI assumed</p>
              <ul className="assumptions">
                {proposal.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          <details className="details-toggle">
            <summary>Rule definitions (validated by Handrail, drafted by {proposal.model})</summary>
            <JsonBlock value={{ add: proposal.add, remove: proposal.remove }} />
          </details>
          <div className="decide-buttons">
            <button className="btn btn-secondary" onClick={() => setProposal(null)} disabled={busy !== null}>
              Discard
            </button>
            <button className="btn btn-primary" onClick={() => void apply()} disabled={busy !== null}>
              {busy === "apply" ? "Applying…" : "Apply to policy"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Matches DEFAULT_EXPIRE_AFTER_HOURS in src/policy/types.ts. */
const DEFAULT_EXPIRE_AFTER_HOURS = 24;

/** How long a held call waits for a human before it expires (never sent to PayPal). Part of the policy. */
function HoldExpiry({ policy, isAdmin, onSave }: { policy: Policy; isAdmin: boolean; onSave: (next: Policy, source: string) => Promise<string | null> }) {
  const current = policy.approvals?.expireAfterHours ?? DEFAULT_EXPIRE_AFTER_HOURS;
  const [hours, setHours] = useState(String(current));
  const [state, setState] = useState<{ tone: string; text: string } | null>(null);
  const value = Number(hours);
  const valid = Number.isFinite(value) && value >= 1 && value <= 720;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const error = await onSave({ ...policy, approvals: { expireAfterHours: value } }, `Held calls expire after ${value} hours`);
    setState(error ? { tone: "bad", text: error } : { tone: "good", text: `Saved. Calls held from now on expire after ${value} hours.` });
  }

  return (
    <section className="card">
      <h2 className="section-title">Held calls</h2>
      <p className="section-help">
        A held call that nobody approves or rejects within{" "}
        <strong>
          {current} hour{current === 1 ? "" : "s"}
        </strong>{" "}
        expires. Expired calls are never sent to PayPal, the agent is told, and the log records it.
        {policy.approvals ? "" : " (The default.)"}
      </p>
      {isAdmin && (
        <form className="inline-form" onSubmit={submit}>
          <label className="inline-label">
            Expire after
            <input
              className="input input-sm"
              type="number"
              min={1}
              max={720}
              step="any"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              aria-invalid={!valid}
            />
            hours
          </label>
          <button className="btn btn-secondary" disabled={!valid || value === current}>
            Save
          </button>
        </form>
      )}
      {isAdmin && !valid && <p className="error">Enter a number of hours from 1 to 720 (30 days).</p>}
      {state && <p className={`outcome outcome-${state.tone}`}>{state.text}</p>}
    </section>
  );
}
