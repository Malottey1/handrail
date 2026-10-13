import { classifyTool } from "./classify.js";
import { formatHundredths, formatMoney, toHundredths } from "./money.js";
import type { CallFacts, CumulativeTotal, Decision, Evaluation, HistoryEntry, Policy, RefundEntry, Rule, RuleHit } from "./types.js";

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
  /** Refunds Handrail sent or holds (any age), for cumulative limits. Excludes this call. */
  refunds?: RefundEntry[];
  /** The agent making this call (its key id, or name for keyless agents), for per-agent limits. */
  agent?: string | null;
}

/**
 * Decides allow / require_approval / block for one tool call. Pure and
 * deterministic: the same input always gives the same output. Every rule that
 * applies is checked and the most severe decision wins.
 */
export function evaluate({ facts, policy, history, now, approved = false, refunds = [], agent = null }: EvaluateInput): Evaluation {
  const toolClass = classifyTool(facts.tool);
  const hits: RuleHit[] = [];

  for (const rule of policy.rules) {
    if (!rule.tools.includes(facts.tool)) continue;
    const hit = rule.type === "cumulative_limit" ? checkCumulative(rule, facts, refunds, agent, now) : checkRule(rule, facts, history, now);
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

    case "cumulative_limit":
      return null; // checkCumulative

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

/** Which capture, order and payer a refund is for: from PayPal when verified, else the capture id the agent named. */
export function refundScope(facts: CallFacts): { captureId: string | null; orderId: string | null; payer: string | null } {
  const v = facts.verified;
  const argCapture = typeof facts.args.capture_id === "string" && facts.args.capture_id ? facts.args.capture_id : null;
  return {
    captureId: v?.capture?.id ?? argCapture,
    orderId: v?.order?.id ?? null,
    payer: v?.payer?.id ?? v?.payer?.email?.toLowerCase() ?? null,
  };
}

/** The key a per-agent limit groups by: the agent key's id, or the name for keyless agents (stdio). */
export const agentKey = (agent: { keyId: string | null; name: string } | null | undefined) => (agent ? (agent.keyId ?? `name:${agent.name}`) : null);

type CumulativeRule = Extract<Rule, { type: "cumulative_limit" }>;
const PER_WORDS = { capture: "capture", order: "order", payer: "customer", agent: "agent" } as const;

/**
 * Refunds on the same capture/order/payer/agent, including this one and held
 * ones, against `max`. For a capture or order, "already refunded" is the
 * larger of PayPal's record (which includes refunds made outside Handrail)
 * and Handrail's log (which includes refunds PayPal may not show yet). If the
 * PayPal lookup failed, a capture falls back to the log; an order or payer
 * can't be identified without PayPal, so the call is held (fail closed).
 */
function checkCumulative(rule: CumulativeRule, facts: CallFacts, refunds: RefundEntry[], agent: string | null, now: number): RuleHit | null {
  const hit = (decision: Decision, reason: string, total?: CumulativeTotal): RuleHit => ({ ruleId: rule.id, decision, reason, ...(total ? { total } : {}) });
  const word = PER_WORDS[rule.per];
  const max = toHundredths(rule.max)!;
  if (!facts.amount) return hit("require_approval", `Amount for ${facts.tool} is unknown, so the per-${word} refund total can't be checked`);
  if (facts.amount.currency !== rule.currency) {
    return hit("require_approval", `Amount is in ${facts.amount.currency}, but the per-${word} refund total is set in ${rule.currency}`);
  }

  const v = facts.verified;
  const fromPayPal = v?.source === "paypal";
  const argCapture = typeof facts.args.capture_id === "string" && facts.args.capture_id ? facts.args.capture_id : null;
  let key: string | null = null;
  let paypalAlready: number | null | undefined; // undefined: PayPal isn't a source for this scope
  let paid: number | null = null;
  const inCurrency = (m: { hundredths: number; currency: string } | null | undefined) => (m && m.currency === rule.currency ? m.hundredths : null);
  switch (rule.per) {
    case "capture":
      key = v?.capture?.id ?? argCapture;
      if (fromPayPal && v!.refunds) paypalAlready = inCurrency(v!.refunds.capture ?? { hundredths: 0, currency: rule.currency });
      if (fromPayPal) paid = inCurrency(v!.capture?.amount);
      break;
    case "order":
      key = fromPayPal ? (v!.order?.id ?? null) : null;
      if (fromPayPal && v!.refunds) paypalAlready = inCurrency(v!.refunds.order ?? { hundredths: 0, currency: rule.currency });
      if (fromPayPal) paid = inCurrency(v!.order?.amount);
      break;
    case "payer":
      key = fromPayPal ? (v!.payer?.id ?? v!.payer?.email?.toLowerCase() ?? null) : null;
      break;
    case "agent":
      key = agent;
      break;
  }
  if (!key) {
    const why = v?.source === "unavailable" ? "PayPal couldn't be checked" : `PayPal doesn't identify the ${word}`;
    return hit("require_approval", `Can't tell which ${word} this refund is for (${why}), so the per-${word} refund total can't be checked`);
  }
  if (paypalAlready === null) {
    return hit("require_approval", `PayPal reports refunds on this ${word} in another currency, so the ${rule.currency} total can't be checked`);
  }

  const window = rule.windowSeconds ?? (rule.per === "agent" ? 86400 : null);
  const since = window === null ? -Infinity : now - window * 1000;
  const keyOf = (r: RefundEntry) =>
    rule.per === "capture" ? r.captureId : rule.per === "order" ? r.orderId : rule.per === "payer" ? r.payer : r.agentKeyId; // payer keys are normalized by refundScope
  const related = refunds.filter((r) => r.at > since && keyOf(r) === key);
  if (related.some((r) => !r.amount || r.amount.currency !== rule.currency)) {
    return hit("require_approval", `An earlier refund on this ${word} has an unknown or different-currency amount, so the total can't be checked`);
  }
  const sum = (state: RefundEntry["state"]) => related.filter((r) => r.state === state).reduce((s, r) => s + r.amount!.hundredths, 0);
  const sentByHandrail = sum("sent");
  const held = sum("held");
  const usePayPal = paypalAlready !== undefined && paypalAlready >= sentByHandrail;
  const already = usePayPal ? paypalAlready! : sentByHandrail;
  const total = already + held + facts.amount.hundredths;
  if (total <= max) return null;

  const detail: CumulativeTotal = {
    per: rule.per,
    key,
    currency: rule.currency,
    already,
    source: usePayPal ? "paypal" : "handrail",
    held,
    thisCall: facts.amount.hundredths,
    total,
    limit: max,
    paid,
  };
  const parts = [
    `${formatHundredths(already)} already refunded (${usePayPal ? "per PayPal" : "per Handrail's log"})`,
    ...(held ? [`${formatHundredths(held)} held for approval`] : []),
    `${formatMoney(facts.amount)} now`,
  ];
  return hit(
    rule.decision,
    `Refunds on this ${word} would total ${formatHundredths(total)} ${rule.currency}: ${parts.join(" + ")}. ` +
      `Limit ${formatHundredths(max)} ${rule.currency}${paid !== null ? `; the customer paid ${formatHundredths(paid)}` : ""}`,
    detail,
  );
}

function describeWindow(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? "24 hours" : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
