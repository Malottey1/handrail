import { ArrowRight, CircleAlert, Clock, Download, Info, Minus, Plus, Sparkles, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api, ApiError, can, type Decision, type Policy, type PolicyProposal, type PolicyResponse, type Session } from "../api";
import { DecisionPill, JsonBlock, Mono, PageHeader, usePoll } from "../components";
import { describeRule, duration, toolLabel } from "../format";

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
  "Block every dispute concession",
];

const MAX_INSTRUCTION = 1000;

/** Matches DEFAULT_EXPIRE_AFTER_HOURS in src/policy/types.ts. */
const DEFAULT_EXPIRE_AFTER_HOURS = 24;
const EXPIRY_CHOICES = [1, 4, 8, 12, 24, 48, 72, 168, 336, 720];

type Rule = Policy["rules"][number];
type Save = (next: Policy, source: string) => Promise<string | null>;

/** Short facts about a rule, beside its sentence: which tools, and what it counts. */
function ruleChips(r: Rule): string[] {
  const chips = r.tools.map((t) => toolLabel(t));
  switch (r.type) {
    case "tool":
      chips.push("Always");
      break;
    case "amount_ceiling":
      chips.push(`Amount > ${r.max} ${r.currency}`);
      break;
    case "rate_limit":
      chips.push(`> ${r.max} calls per ${duration(r.windowSeconds)}`);
      break;
    case "spend_limit":
      chips.push(`Total > ${r.max} ${r.currency} per ${duration(r.windowSeconds)}`);
      break;
    case "payee_allowlist":
      chips.push(`Only ${r.allow.join(", ")}`);
      break;
    case "cumulative_limit":
      chips.push(`Total > ${r.max} ${r.currency}`, `Per ${r.per === "payer" ? "customer" : r.per}`);
      if (r.windowSeconds) chips.push(`In ${duration(r.windowSeconds)}`);
      break;
  }
  return chips;
}

export function PolicyView({ session, title, subtitle }: { session: Session; title: string; subtitle: string }) {
  const policy = usePoll(() => api<PolicyResponse>(session, "/policy"), 15000);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"draft" | "apply" | null>(null);
  const [proposal, setProposal] = useState<PolicyProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const data = policy.data;
  const isAdmin = can(session, "admin");

  async function save(next: Policy, source: string): Promise<string | null> {
    if (!data) return "The policy hasn't loaded yet.";
    try {
      await api(session, "/policy", { method: "PUT", body: { policy: next, baseHash: data.hash, source } });
      policy.refresh();
      return null;
    } catch (err) {
      policy.refresh();
      return err instanceof ApiError ? err.message : String(err);
    }
  }

  async function removeRule(rule: Rule) {
    if (!data || !window.confirm(`Remove this rule?\n\n${describeRule(rule)}\n\nThe change is recorded in the audit log.`)) return;
    const problem = await save({ ...data.policy, rules: data.policy.rules.filter((r) => r.id !== rule.id) }, `Removed rule ${rule.id}`);
    if (problem) window.alert(problem);
  }

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
    const problem = await save(proposal.policy, text.trim());
    setBusy(null);
    if (problem) {
      setError(problem);
    } else {
      setApplied(`Applied: ${proposal.sentences.add.concat(proposal.sentences.remove.map((s) => `removed “${s}”`)).join("; ")}`);
      setProposal(null);
      setText("");
    }
  }

  function exportRules() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data.policy, null, 2) + "\n"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `handrail-policy-${data.hash.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const header = (
    <PageHeader
      title={title}
      subtitle={subtitle}
      actions={
        <button type="button" className="btn btn-secondary btn-lg" onClick={exportRules} disabled={!data}>
          <Download size={18} aria-hidden="true" />
          Export rules
        </button>
      }
    />
  );
  if (policy.error && !data)
    return (
      <>
        {header}
        <p className="error">{policy.error.message}</p>
      </>
    );
  if (!data)
    return (
      <>
        {header}
        <p className="muted">Loading…</p>
      </>
    );

  const rules = [...data.policy.rules].sort((a, b) => SEVERITY[a.decision] - SEVERITY[b.decision]);
  const aiOn = data.ai.enabled;
  const showDraft = isAdmin && (proposal || busy === "draft");

  return (
    <>
      {header}
      <div className="policy-layout">
        <div className="policy-main">
          {isAdmin ? (
            <section className="card policy-card composer">
              <header className="policy-card-head">
                <span className="policy-card-icon" aria-hidden="true">
                  <Sparkles size={20} />
                </span>
                <div>
                  <h2>Plain-English rule builder</h2>
                  <p>
                    {aiOn
                      ? "Describe a rule in plain English. The AI drafts it, Handrail checks it and restates it, and nothing changes until you apply it."
                      : "Set ANTHROPIC_API_KEY in the server's environment and restart Handrail to draft rules in plain English."}
                  </p>
                </div>
              </header>
              {aiOn && (
                <>
                  <div className="composer-field">
                    <textarea
                      ref={composerRef}
                      value={text}
                      maxLength={MAX_INSTRUCTION}
                      placeholder="Example: Refunds over $250 need my approval, and block every dispute concession."
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) void draft();
                      }}
                      disabled={busy !== null}
                      aria-label="Describe a rule"
                    />
                    <span className="composer-count num">
                      {text.length}/{MAX_INSTRUCTION}
                    </span>
                  </div>
                  <div className="composer-actions">
                    <div className="examples">
                      {EXAMPLES.map((ex) => (
                        <button key={ex} type="button" className="example" onClick={() => setText(ex)} disabled={busy !== null}>
                          {ex}
                        </button>
                      ))}
                    </div>
                    <button type="button" className="btn btn-dark btn-lg" onClick={() => void draft()} disabled={busy !== null || !text.trim()}>
                      {busy === "draft" ? "Drafting…" : "Draft rules"}
                      <ArrowRight size={18} aria-hidden="true" />
                    </button>
                  </div>
                </>
              )}
              {error && <p className="error">{error}</p>}
              {applied && <p className="outcome outcome-good">{applied}</p>}
            </section>
          ) : (
            <p className="notice">Only admins can change the policy. You can see every rule that applies.</p>
          )}

          <section className="card policy-card">
            <header className="policy-card-head policy-card-head-row">
              <div>
                <h2>Policy rules</h2>
                <p>When several rules match a call, the strictest wins: block, then hold for approval, then allow. A human can never approve past a block.</p>
              </div>
              {isAdmin && aiOn && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    composerRef.current?.focus();
                    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                >
                  <Plus size={17} aria-hidden="true" />
                  Add rule
                </button>
              )}
            </header>
            {rules.length === 0 ? (
              <p className="muted">No rules. Every call gets the default for its kind of tool, below.</p>
            ) : (
              <ol className="rule-cards">
                {rules.map((r, i) => (
                  <li key={r.id} className={`rule-card rule-${r.decision}`}>
                    <span className="rule-num num" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div className="rule-body">
                      <p className="rule-title">
                        {describeRule(r)}
                        <DecisionPill decision={r.decision} />
                      </p>
                      {r.description && <p className="rule-desc">{r.description}</p>}
                      <div className="chip-row">
                        {ruleChips(r).map((c) => (
                          <span key={c} className="chip">
                            {c}
                          </span>
                        ))}
                        <span className="chip chip-id">{r.id}</span>
                      </div>
                    </div>
                    {isAdmin && (
                      <button type="button" className="icon-btn icon-btn-plain" onClick={() => void removeRule(r)} aria-label={`Remove ${r.id}`} title="Remove rule">
                        <Trash2 size={18} />
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="policy-side">
          {showDraft && <DraftCard proposal={proposal} busy={busy} onDiscard={() => setProposal(null)} onApply={() => void apply()} />}

          <HoldExpiry key={data.hash} policy={data.policy} isAdmin={isAdmin} onSave={save} />

          <section className="card policy-card">
            <header className="policy-card-head">
              <div>
                <h2>When no rule matches</h2>
                <p>Every call gets one of these, by the kind of tool it uses.</p>
              </div>
            </header>
            <ul className="defaults-list">
              {(Object.keys(DEFAULT_LABELS) as Array<keyof Policy["defaults"]>).map((k) => (
                <li key={k}>
                  <span>{DEFAULT_LABELS[k]}</span>
                  <DecisionPill decision={data.policy.defaults[k]} />
                </li>
              ))}
            </ul>
          </section>

          <section className="policy-note">
            <Info size={17} aria-hidden="true" />
            <p>
              Enforced by deterministic code on every call; the AI only drafts. If Handrail can't work out an amount or payee, the call is held
              rather than guessed. Policy <Mono>{data.hash.slice(0, 12)}</Mono>; every change is in the audit log with who made it.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

/** The AI's proposal, restated by Handrail, with its assumptions and Handrail's warnings. Nothing applies until "Apply rules". */
function DraftCard({
  proposal,
  busy,
  onDiscard,
  onApply,
}: {
  proposal: PolicyProposal | null;
  busy: "draft" | "apply" | null;
  onDiscard: () => void;
  onApply: () => void;
}) {
  if (!proposal) {
    return (
      <section className="card policy-card draft-card" aria-live="polite">
        <header className="policy-card-head">
          <span className="policy-card-icon policy-card-icon-ai" aria-hidden="true">
            <Sparkles size={20} />
          </span>
          <div>
            <h2>AI draft</h2>
            <p>Drafting rules from your description…</p>
          </div>
        </header>
        <div className="shimmer" />
      </section>
    );
  }
  const changes = proposal.add.length + proposal.remove.length;
  return (
    <section className="card policy-card draft-card" aria-live="polite">
      <header className="policy-card-head">
        <span className="policy-card-icon policy-card-icon-ai" aria-hidden="true">
          <Sparkles size={20} />
        </span>
        <div>
          <h2>
            AI draft <span className="pill pill-ai">Review before applying</span>
          </h2>
          <p>{proposal.question ? "The AI needs one more detail before it can draft a rule." : "Handrail checked the draft and restated it below. Check the rules, warnings and assumptions."}</p>
        </div>
      </header>

      {proposal.question ? (
        <div className="draft-question">
          <p>{proposal.question}</p>
          <p className="muted">Add the detail to your description and draft again.</p>
        </div>
      ) : (
        <>
          <div className="draft-rules">
            <p className="draft-rules-title">Proposed changes ({changes})</p>
            <ul>
              {proposal.add.map((r, i) => (
                <li key={r.id}>
                  <span className="draft-sign draft-add" aria-label="Add">
                    <Plus size={15} />
                  </span>
                  <div>
                    <p className="draft-rule">
                      {proposal.sentences.add[i]?.replace(/ → .*$/, "")}
                      <DecisionPill decision={r.decision} />
                    </p>
                    <div className="chip-row">
                      {ruleChips(r).map((c) => (
                        <span key={c} className="chip">
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
              {proposal.sentences.remove.map((s, i) => (
                <li key={proposal.remove[i]}>
                  <span className="draft-sign draft-remove" aria-label="Remove">
                    <Minus size={15} />
                  </span>
                  <p className="draft-rule">Remove: {s}</p>
                </li>
              ))}
            </ul>
          </div>
          {proposal.assumptions.length > 0 && (
            <div className="draft-notes">
              <p className="draft-notes-title">
                <Sparkles size={16} aria-hidden="true" />
                AI notes and assumptions
              </p>
              <ul>
                {proposal.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {proposal.warnings.length > 0 && (
            <div className="draft-warnings">
              <p className="draft-notes-title">
                <CircleAlert size={16} aria-hidden="true" />
                Warnings from Handrail
              </p>
              <ul>
                {proposal.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <details className="more">
            <summary>Rule definitions (validated by Handrail, drafted by {proposal.model})</summary>
            <JsonBlock value={{ add: proposal.add, remove: proposal.remove }} />
          </details>
        </>
      )}
      <div className="draft-actions">
        <button type="button" className="btn btn-secondary btn-lg" onClick={onDiscard} disabled={busy !== null}>
          Discard
        </button>
        {!proposal.question && (
          <button type="button" className="btn btn-dark btn-lg" onClick={onApply} disabled={busy !== null || changes === 0}>
            {busy === "apply" ? "Applying…" : "Apply rules"}
          </button>
        )}
      </div>
    </section>
  );
}

const hoursLabel = (h: number) => (h % 24 === 0 && h >= 48 ? `${h / 24} days` : `${h} hour${h === 1 ? "" : "s"}`);

/** How long a held call waits for a human before it expires (never sent to PayPal). Part of the policy. */
function HoldExpiry({ policy, isAdmin, onSave }: { policy: Policy; isAdmin: boolean; onSave: Save }) {
  const current = policy.approvals?.expireAfterHours ?? DEFAULT_EXPIRE_AFTER_HOURS;
  const [state, setState] = useState<{ tone: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const choices = EXPIRY_CHOICES.includes(current) ? EXPIRY_CHOICES : [...EXPIRY_CHOICES, current].sort((a, b) => a - b);

  async function change(value: number) {
    if (value === current) return;
    setSaving(true);
    const error = await onSave({ ...policy, approvals: { expireAfterHours: value } }, `Held calls expire after ${value} hours`);
    setSaving(false);
    setState(error ? { tone: "bad", text: error } : { tone: "good", text: `Saved. Calls held from now on expire after ${hoursLabel(value)}.` });
  }

  return (
    <section className="card policy-card">
      <header className="policy-card-head">
        <span className="policy-card-icon policy-card-icon-warn" aria-hidden="true">
          <Clock size={20} />
        </span>
        <div>
          <h2>Held calls</h2>
          <p>How long a held call can wait for a human.</p>
        </div>
      </header>
      <div className="expiry-row">
        <label className="field">
          <span className="field-label">Expiry time</span>
          <span className="select-pill select-field">
            <select value={current} onChange={(e) => void change(Number(e.target.value))} disabled={!isAdmin || saving} aria-label="Held calls expire after">
              {choices.map((h) => (
                <option key={h} value={h}>
                  {hoursLabel(h)}
                </option>
              ))}
            </select>
          </span>
        </label>
        <p className="expiry-note">
          <Info size={16} aria-hidden="true" />
          Unanswered after {hoursLabel(current)}, a call expires: it's never sent to PayPal, the agent is told, and the log records it.
          {policy.approvals ? "" : " (The default.)"}
        </p>
      </div>
      {!isAdmin && <p className="fine">Only admins can change this.</p>}
      {state && <p className={`outcome outcome-${state.tone}`}>{state.text}</p>}
    </section>
  );
}
