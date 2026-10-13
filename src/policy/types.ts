import { z } from "zod";
import type { Money } from "./money.js";

export const DECISIONS = ["allow", "require_approval", "block"] as const;
export type Decision = (typeof DECISIONS)[number];

const decision = z.enum(DECISIONS);
const toolList = z.array(z.string().min(1)).min(1);
const amount = z.string().regex(/^\d+(\.\d{1,2})?$/, 'amount must look like "100" or "100.00"');
const currency = z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code");
const ruleBase = {
  id: z.string().min(1),
  description: z.string().optional(),
};

/** Applies a fixed decision to every call of the listed tools. */
const toolRule = z.object({
  ...ruleBase,
  type: z.literal("tool"),
  tools: toolList,
  decision,
});

/**
 * Fires when a single call's amount exceeds `max`. A call whose amount can't be
 * determined, or is in a different currency, is held for approval (fail closed):
 * a human can check it, where a block would stop every unverifiable call.
 */
const amountCeilingRule = z.object({
  ...ruleBase,
  type: z.literal("amount_ceiling"),
  tools: toolList,
  max: amount,
  currency,
  decision,
});

/** Fires when more than `max` calls of the listed tools were forwarded in the window. */
const rateLimitRule = z.object({
  ...ruleBase,
  type: z.literal("rate_limit"),
  tools: toolList,
  max: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  decision,
});

/** Fires when this call would push the total forwarded amount in the window over `max`. */
const spendLimitRule = z.object({
  ...ruleBase,
  type: z.literal("spend_limit"),
  tools: toolList,
  max: amount,
  currency,
  windowSeconds: z.number().int().positive(),
  decision,
});

/**
 * Fires when refunds on the same capture, order, payer or agent, including
 * this one, would add up to more than `max`. Counts refunds Handrail allowed
 * or a human approved and sent, plus held ones still waiting, so neither
 * splitting a refund nor stacking held requests slips under it. For a capture
 * or order, PayPal's own refund record is the source of truth (it includes
 * refunds made outside Handrail); Handrail's log is the fallback. Per payer
 * and per agent use Handrail's log over `windowSeconds` (agent: default a day).
 * Whatever can't be determined (amount, payer, order) holds the call.
 */
const cumulativeLimitRule = z.object({
  ...ruleBase,
  type: z.literal("cumulative_limit"),
  tools: toolList.refine((t) => t.every((x) => x === "create_refund"), "cumulative_limit applies to create_refund only"),
  per: z.enum(["capture", "order", "payer", "agent"]),
  max: amount,
  currency,
  windowSeconds: z.number().int().positive().optional(),
  decision,
}).refine((r) => r.windowSeconds === undefined || r.per === "payer" || r.per === "agent", {
  message: "windowSeconds applies to per payer or per agent; a capture's or order's total counts every refund on it",
  path: ["windowSeconds"],
});

/**
 * Fires when the call's counterparty email is not on the allowlist. Matches a
 * full address or a domain written as "@example.com". Unknown payee fails closed.
 */
const payeeAllowlistRule = z.object({
  ...ruleBase,
  type: z.literal("payee_allowlist"),
  tools: toolList,
  allow: z.array(z.string().min(1)).min(1),
  decision,
});

export const ruleSchema = z.discriminatedUnion("type", [
  toolRule,
  amountCeilingRule,
  rateLimitRule,
  spendLimitRule,
  payeeAllowlistRule,
  cumulativeLimitRule,
]);

/** Held calls that nobody decides in time expire: never sent to PayPal, and the agent is told. */
export const DEFAULT_EXPIRE_AFTER_HOURS = 24;

export const policySchema = z.object({
  version: z.literal(1),
  /** How long a held call waits for a human. Optional; defaults to 24 hours. */
  approvals: z
    .object({
      expireAfterHours: z.number().positive().max(720, "held calls can wait at most 720 hours (30 days)"),
    })
    .optional(),
  /** Decision when no rule fires, by tool class. */
  defaults: z.object({
    read: decision,
    write: decision,
    money: decision,
    unknown: decision,
  }),
  rules: z.array(ruleSchema),
});

export type Rule = z.infer<typeof ruleSchema>;
export type Policy = z.infer<typeof policySchema>;

/** How long a held call stays approvable under this policy, in milliseconds. */
export function holdTtlMs(policy: Policy): number {
  return (policy.approvals?.expireAfterHours ?? DEFAULT_EXPIRE_AFTER_HOURS) * 60 * 60 * 1000;
}

export type ToolClass = "read" | "write" | "money" | "unknown";

/**
 * What PayPal itself says about the object a call acts on, looked up with
 * read-only API calls before deciding. Never taken from the agent's arguments.
 */
export interface VerifiedFacts {
  /** "unavailable": the lookup failed or there was nothing to look up (`error` says which). */
  source: "paypal" | "unavailable";
  error?: string;
  capture?: { id: string; status: string | null; amount: Money | null };
  order?: { id: string; status: string | null; amount: Money | null };
  /** The payer: PayPal account email and id, or for card payments the cardholder and card. */
  payer?: { id: string | null; email: string | null; name: string | null; card: string | null };
  /** Refunds PayPal has recorded (completed or pending) on this capture and across its order. */
  refunds?: { capture: Money | null; order: Money | null; count: number };
  dispute?: { id: string; status: string | null; reason: string | null; stage: string | null; amount: Money | null; respondBy: string | null };
  invoice?: { id: string; status: string | null; amount: Money | null; recipient: string | null };
  subscription?: { id: string; status: string | null; plan: string | null; subscriber: string | null };
}

/** What Handrail knows about a call before deciding. */
export interface CallFacts {
  tool: string;
  args: Record<string, unknown>;
  /** The amount this call moves, if known. */
  amount: Money | null;
  /** Where the amount came from, for explanations. */
  amountSource: "arguments" | "lookup" | "none";
  /** Counterparty email (e.g. invoice recipient), if known. */
  payee: string | null;
  /** Looked up from PayPal. Absent on calls recorded before this existed. */
  verified?: VerifiedFacts;
}

/** A previously forwarded call, used for rate and spend limits. */
export interface HistoryEntry {
  tool: string;
  /** Epoch milliseconds. */
  at: number;
  amount: Money | null;
}

/** A refund Handrail sent (or holds), with what it was for: for cumulative limits. */
export interface RefundEntry {
  at: number;
  amount: Money | null;
  /** "sent": allowed, or approved and forwarded (not failed). "held": waiting for a human. */
  state: "sent" | "held";
  captureId: string | null;
  orderId: string | null;
  payer: string | null;
  agentKeyId: string | null;
}

/** The running total behind a cumulative_limit hit, for the approval card. */
export interface CumulativeTotal {
  per: "capture" | "order" | "payer" | "agent";
  /** Which capture, order, payer or agent. */
  key: string;
  currency: string;
  /** Already refunded (hundredths), and where that number came from. */
  already: number;
  source: "paypal" | "handrail";
  /** Held refunds still waiting for a human. */
  held: number;
  thisCall: number;
  total: number;
  limit: number;
  /** What the customer paid, when known (capture or order amount). */
  paid: number | null;
}

export interface RuleHit {
  ruleId: string;
  decision: Decision;
  reason: string;
  total?: CumulativeTotal;
}

export interface Evaluation {
  decision: Decision;
  toolClass: ToolClass;
  /** Every rule that fired. Empty when the class default applied. */
  hits: RuleHit[];
  /** One-line summary for logs and the agent. */
  reason: string;
}
