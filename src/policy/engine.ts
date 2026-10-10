import { classifyTool } from "./classify.js";
import { formatHundredths, formatMoney, toHundredths } from "./money.js";
import type { CallFacts, Decision, Evaluation, HistoryEntry, Policy, Rule, RuleHit } from "./types.js";

const SEVERITY: Record<Decision, number> = { allow: 0, require_approval: 1, block: 2 };

export interface EvaluateInput {
  facts: CallFacts;
  policy: Policy;
  /** Previously forwarded calls (any age; the engine applies each rule's window). */
  history: HistoryEntry[];
  /** Epoch milliseconds. Passed in so evaluation is deterministic. */
  now: number;
  /**
   * True when a human has approved this exact call. Approval satisfies
   * require_approval hits but never overrides a block.
   */
  approved?: boolean;
}

/**
 * Decides allow / require_approval / block for one tool call. Pure and
 * deterministic: the same input always gives the same output. Every rule that
 * applies is checked and the most severe decision wins.
 */
export function evaluate({ facts, policy, history, now, approved = false }: EvaluateInput): Evaluation {
  const toolClass = classifyTool(facts.tool);
  const hits: RuleHit[] = [];

  for (const rule of policy.rules) {
    if (!rule.tools.includes(facts.tool)) continue;
    const hit = checkRule(rule, facts, history, now);
    if (hit) hits.push(hit);
  }

  if (hits.length === 0) {
    const decision = policy.defaults[toolClass];
    return {
      decision: approved && decision === "require_approval" ? "allow" : decision,
      toolClass,
      hits,
      reason: `No rule matched; default for ${toolClass} tools is ${decision}`,
    };
  }

  const worst = hits.reduce((a, b) => (SEVERITY[b.decision] > SEVERITY[a.decision] ? b : a)).decision;
  const decision = approved && worst === "require_approval" ? "allow" : worst;
  const reason = hits
    .filter((h) => h.decision === worst)
    .map((h) => h.reason)
    .join("; ");

  return { decision, toolClass, hits, reason: approved && decision === "allow" ? `Approved by a human. ${reason}` : reason };
}

function checkRule(rule: Rule, facts: CallFacts, history: HistoryEntry[], now: number): RuleHit | null {
  const hit = (decision: Decision, reason: string): RuleHit => ({ ruleId: rule.id, decision, reason });

  switch (rule.type) {
    case "tool":
      return hit(rule.decision, rule.description ?? `${facts.tool} is set to ${rule.decision}`);

    case "amount_ceiling": {
      const max = toHundredths(rule.max)!;
      if (!facts.amount) {
        return hit("require_approval", `Amount for ${facts.tool} is unknown, so the ${rule.max} ${rule.currency} ceiling can't be checked`);
      }
      if (facts.amount.currency !== rule.currency) {
        return hit("require_approval", `Amount is in ${facts.amount.currency}, but the ceiling is set in ${rule.currency}`);
      }
      if (facts.amount.hundredths > max) {
        return hit(rule.decision, `${formatMoney(facts.amount)} is over the ${formatHundredths(max)} ${rule.currency} ceiling for ${facts.tool}`);
      }
      return null;
    }

    case "rate_limit": {
      const since = now - rule.windowSeconds * 1000;
      const count = history.filter((h) => rule.tools.includes(h.tool) && h.at > since).length;
      if (count >= rule.max) {
        return hit(rule.decision, `${count} ${rule.tools.join("/")} calls in the last ${describeWindow(rule.windowSeconds)} (limit ${rule.max})`);
      }
      return null;
    }

    case "spend_limit": {
      const max = toHundredths(rule.max)!;
      if (!facts.amount) {
        return hit("require_approval", `Amount for ${facts.tool} is unknown, so the ${rule.max} ${rule.currency} spend limit can't be checked`);
      }
      if (facts.amount.currency !== rule.currency) {
        return hit("require_approval", `Amount is in ${facts.amount.currency}, but the spend limit is set in ${rule.currency}`);
      }
      const since = now - rule.windowSeconds * 1000;
      const spent = history
        .filter((h) => rule.tools.includes(h.tool) && h.at > since && h.amount?.currency === rule.currency)
        .reduce((sum, h) => sum + h.amount!.hundredths, 0);
      if (spent + facts.amount.hundredths > max) {
        return hit(
          rule.decision,
          `${formatMoney(facts.amount)} would bring ${rule.tools.join("/")} spend in the last ${describeWindow(rule.windowSeconds)} to ` +
            `${formatHundredths(spent + facts.amount.hundredths)} ${rule.currency} (limit ${formatHundredths(max)})`,
        );
      }
      return null;
    }

    case "payee_allowlist": {
      if (!facts.payee) {
        return hit("require_approval", `Payee for ${facts.tool} is unknown, so the allowlist can't be checked`);
      }
      const payee = facts.payee.toLowerCase();
      const allowed = rule.allow.some((entry) => {
        const e = entry.toLowerCase();
        return e.startsWith("@") ? payee.endsWith(e) : payee === e;
      });
      return allowed ? null : hit(rule.decision, `${facts.payee} is not on the payee allowlist`);
    }
  }
}

function describeWindow(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? "24 hours" : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
