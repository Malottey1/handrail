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
]);

export const policySchema = z.object({
  version: z.literal(1),
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

export type ToolClass = "read" | "write" | "money" | "unknown";

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
}

/** A previously forwarded call, used for rate and spend limits. */
export interface HistoryEntry {
  tool: string;
  /** Epoch milliseconds. */
  at: number;
  amount: Money | null;
}

export interface RuleHit {
  ruleId: string;
  decision: Decision;
  reason: string;
}

export interface Evaluation {
  decision: Decision;
  toolClass: ToolClass;
  /** Every rule that fired. Empty when the class default applied. */
  hits: RuleHit[];
  /** One-line summary for logs and the agent. */
  reason: string;
}
