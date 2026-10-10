import { api, type Decision, type Policy, type Rule, type Session } from "../api";
import { DecisionPill, Mono, usePoll } from "../components";
import { duration, toolLabel } from "../format";

const money = (max: string, currency: string) => `${Number(max).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${currency}`;
const tools = (list: string[]) => list.map(toolLabel).join(", ");

/** The rule as a sentence, from its structured form. */
export function describeRule(rule: Rule): string {
  switch (rule.type) {
    case "tool":
      return `${tools(rule.tools)}, every time`;
    case "amount_ceiling":
      return `${tools(rule.tools)} over ${money(rule.max, rule.currency)}`;
    case "rate_limit":
      return `More than ${rule.max} ${tools(rule.tools)} calls in ${duration(rule.windowSeconds)}`;
    case "spend_limit":
      return `${tools(rule.tools)} totalling more than ${money(rule.max, rule.currency)} in ${duration(rule.windowSeconds)}`;
    case "payee_allowlist":
      return `${tools(rule.tools)} to anyone other than ${rule.allow.join(", ")}`;
  }
}

const DEFAULT_LABELS: Record<keyof Policy["defaults"], string> = {
  read: "Read-only tools (list, get, search)",
  write: "Other changes (create drafts, update)",
  money: "Money-moving tools no rule matched",
  unknown: "Tools Handrail doesn't recognise",
};

const SEVERITY: Record<Decision, number> = { block: 0, require_approval: 1, allow: 2 };

export function PolicyView({ session }: { session: Session }) {
  const policy = usePoll(() => api<Policy>(session, "/policy"), 15000);
  if (policy.error) return <p className="error">{policy.error.message}</p>;
  if (!policy.data) return <p className="muted">Loading…</p>;

  const rules = [...policy.data.rules].sort((a, b) => SEVERITY[a.decision] - SEVERITY[b.decision]);
  return (
    <div className="policy">
      <p className="lede">
        Enforced by deterministic code on every call. When several rules fire, the strictest wins, and a human can never approve
        past a block. If Handrail can't work out an amount or payee, the call is held rather than guessed.
      </p>
      <section className="card">
        <h2 className="section-title">Rules</h2>
        <ul className="rules">
          {rules.map((r) => (
            <li key={r.id}>
              <DecisionPill decision={r.decision} />
              <div>
                <p className="rule-text">{describeRule(r)}</p>
                <p className="rule-meta">
                  <Mono>{r.id}</Mono>
                  {r.description && <> · {r.description}</>}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2 className="section-title">When no rule matches</h2>
        <ul className="rules">
          {(Object.keys(DEFAULT_LABELS) as Array<keyof Policy["defaults"]>).map((k) => (
            <li key={k}>
              <DecisionPill decision={policy.data!.defaults[k]} />
              <p className="rule-text">{DEFAULT_LABELS[k]}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
