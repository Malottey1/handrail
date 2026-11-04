import { z } from "zod";
import { MONEY_TOOLS, READ_TOOLS, WRITE_TOOLS } from "../policy/classify.js";
import { DECISION_WORDS, ruleSentence, toolLabel } from "../policy/describe.js";
import { parsePolicy } from "../policy/load.js";
import { ruleSchema, type Policy, type Rule } from "../policy/types.js";
import { AI_TIMEOUT_MS, type Llm } from "./llm.js";

/**
 * What the model proposes, after Handrail has validated it. Nothing here takes
 * effect until a human confirms it in the dashboard.
 */
export interface PolicyProposal {
  /** Set when the request was ambiguous; then nothing is proposed. */
  question: string | null;
  add: Rule[];
  remove: string[];
  /** The model's interpretation choices, for the human to check. */
  assumptions: string[];
  /** Handrail's own restatement of the change, generated from the rules (not by the model). */
  sentences: { add: string[]; remove: string[] };
  /** Deterministic notes about the effect of the change. */
  warnings: string[];
  /** The full policy if confirmed; already validated by the policy parser. */
  policy: Policy;
}

export class CompileError extends Error {}

const ALL_TOOLS = [...MONEY_TOOLS, ...WRITE_TOOLS, ...READ_TOOLS];

const answerSchema = z.object({
  question: z.string().trim().max(500).nullable().optional(),
  add: z.array(z.unknown()).max(10).default([]),
  remove: z.array(z.string()).max(20).default([]),
  assumptions: z.array(z.string().trim().max(300)).max(6).default([]),
});

/** JSON Schema for the answer: zod's schema for rules, with tool names limited to PayPal's. */
function answerJsonSchema(policy: Policy): Record<string, unknown> {
  const rule = z.toJSONSchema(ruleSchema) as Record<string, any>;
  delete rule.$schema;
  for (const variant of rule.oneOf) variant.properties.tools.items = { type: "string", enum: ALL_TOOLS };
  return {
    type: "object",
    properties: {
      question: {
        type: ["string", "null"],
        description: "If the request is too ambiguous to turn into rules safely, ask one short question here and propose nothing.",
      },
      add: { type: "array", items: rule, description: "New rules to add." },
      remove: {
        type: "array",
        items: policy.rules.length ? { type: "string", enum: policy.rules.map((r) => r.id) } : { type: "string" },
        description: "Ids of existing rules to remove (e.g. one being replaced by a changed version).",
      },
      assumptions: {
        type: "array",
        items: { type: "string" },
        description: "Interpretation choices you made that the human should check, in plain words.",
      },
    },
    required: ["question", "add", "remove", "assumptions"],
  };
}

export function compileSystemPrompt(policy: Policy): string {
  const catalog = (tools: Set<string>) => [...tools].map((t) => `${t} (${toolLabel(t)})`).join(", ");
  return `You turn a merchant's plain-English instruction into rules for Handrail, a safety layer that checks every PayPal action an AI agent attempts. A human reviews your proposal before it takes effect, and Handrail validates it, so be precise and never guess silently: list interpretation choices as assumptions.

How rules work:
- Each rule names PayPal tools and a decision: "allow", "require_approval" (a human must approve) or "block".
- Every rule that matches a call fires; the strictest decision wins (block > require_approval > allow). So an "allow" rule can never loosen another rule; to loosen the policy, remove the rule that is too strict.
- Rule types:
  - tool: always applies the decision to the listed tools.
  - amount_ceiling: fires when one call's amount is over max (a string like "250.00") in currency (ISO code like "USD").
  - spend_limit: fires when the total of calls in the last windowSeconds, including this one, would exceed max in currency.
  - cumulative_limit (create_refund only): fires when refunds on the same capture, order, payer or agent ("per"), including this one and held ones, would exceed max in currency. Use it for "refunds on one order/payment/customer over $X" and "an agent refunding more than $X a day". windowSeconds only with per payer or agent (agent defaults to a day).
  - rate_limit: fires when more than max (an integer count) calls of the listed tools were already sent in the last windowSeconds.
  - payee_allowlist: fires when the counterparty email is not in allow (full addresses, or domains written "@example.com").
- Windows are in seconds: hour 3600, day 86400, week 604800.
- Currency is USD unless the merchant says otherwise.
- Rule ids are short, unique kebab-case names describing the rule, e.g. "refund-approval-over-250".
- To change an existing rule, remove its id and add the new version.
- Give each new rule a one-sentence description in plain English.

PayPal tools:
- Money-moving: ${catalog(MONEY_TOOLS)}
- Other changes: ${catalog(WRITE_TOOLS)}
- Read-only: ${catalog(READ_TOOLS)}
"Refunds" means create_refund; include record_refund_for_invoice only if the merchant mentions invoices. "Captures" or "payments" the agent collects means pay_order.

Current rules:
${policy.rules.map((r) => `- ${r.id}: ${ruleSentence(r)}`).join("\n") || "- none"}
Defaults when no rule matches: read ${policy.defaults.read}, other changes ${policy.defaults.write}, money-moving ${policy.defaults.money}, unknown tools ${policy.defaults.unknown}.`;
}

const KIND_WORDS: Record<Rule["type"], string> = {
  tool: "always-on rule",
  amount_ceiling: "amount limit",
  spend_limit: "spending limit",
  rate_limit: "rate limit",
  payee_allowlist: "payee allowlist",
  cumulative_limit: "running-total limit",
};

/** Handrail's own notes on what a change does, computed from the rules. */
export function proposalWarnings(current: Policy, add: Rule[], remove: string[]): string[] {
  const warnings: string[] = [];
  const after = [...current.rules.filter((r) => !remove.includes(r.id)), ...add];
  for (const id of remove) {
    const rule = current.rules.find((r) => r.id === id);
    if (!rule || rule.decision === "allow") continue;
    warnings.push(`Removes a ${DECISION_WORDS[rule.decision].toLowerCase()} rule: “${ruleSentence(rule)}”.`);
    // A replacement often covers fewer tools than the rule it replaces.
    for (const tool of rule.tools) {
      const stillCovered = after.some((r) => r.type === rule.type && r.decision !== "allow" && r.tools.includes(tool));
      if (!stillCovered) warnings.push(`${toolLabel(tool)} will no longer have any ${KIND_WORDS[rule.type]}.`);
    }
  }
  for (const rule of add) {
    if (rule.decision === "allow") {
      warnings.push(`“${rule.id}” is an allow rule. It can't override stricter rules, so it changes nothing on its own.`);
    }
    if ("currency" in rule && rule.currency !== "USD") {
      warnings.push(`“${rule.id}” is in ${rule.currency}. Calls in other currencies are held for approval rather than compared.`);
    }
  }
  return warnings;
}

function validate(raw: unknown, current: Policy): PolicyProposal {
  const answer = answerSchema.parse(raw);
  const question = answer.question?.trim() || null;
  if (question && answer.add.length === 0 && answer.remove.length === 0) {
    return { question, add: [], remove: [], assumptions: answer.assumptions, sentences: { add: [], remove: [] }, warnings: [], policy: current };
  }
  if (answer.add.length === 0 && answer.remove.length === 0) {
    throw new CompileError("The model didn't propose any change.");
  }

  const unknownIds = answer.remove.filter((id) => !current.rules.some((r) => r.id === id));
  if (unknownIds.length) throw new CompileError(`Proposed removing rules that don't exist: ${unknownIds.join(", ")}`);

  // The same parser that loads policy.json: schema, real tool names, unique ids.
  const policy = parsePolicy({
    ...current,
    rules: [...current.rules.filter((r) => !answer.remove.includes(r.id)), ...answer.add],
  });
  const add = policy.rules.slice(policy.rules.length - answer.add.length);
  const removed = current.rules.filter((r) => answer.remove.includes(r.id));

  return {
    question: null,
    add,
    remove: answer.remove,
    assumptions: answer.assumptions,
    sentences: { add: add.map(ruleSentence), remove: removed.map(ruleSentence) },
    warnings: proposalWarnings(current, add, answer.remove),
    policy,
  };
}

/**
 * Asks the model for rules, then validates them like a hand-written policy.
 * If validation fails, the model gets one chance to fix its answer.
 */
export async function compilePolicy(instruction: string, current: Policy, llm: Llm): Promise<PolicyProposal> {
  const text = instruction.trim();
  if (!text) throw new CompileError("Write the rule you want in plain English.");
  if (text.length > 1000) throw new CompileError("Keep the instruction under 1,000 characters.");

  const request = {
    signal: AbortSignal.timeout(llm.timeoutMs ?? AI_TIMEOUT_MS),
    system: compileSystemPrompt(current),
    schema: answerJsonSchema(current),
    name: "propose_policy_change",
    description: "Propose rules implementing the merchant's instruction, or ask one question if it's ambiguous.",
    maxTokens: 2000,
  };

  const first = await llm.json({ ...request, user: `Merchant's instruction:\n${text}` });
  try {
    return validate(first, current);
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err);
    const second = await llm.json({
      ...request,
      user: `Merchant's instruction:\n${text}\n\nYour previous answer was rejected by Handrail's validator:\n${problem}\n\nPrevious answer:\n${JSON.stringify(first)}\n\nFix it.`,
    });
    try {
      return validate(second, current);
    } catch (err2) {
      throw new CompileError(`Couldn't turn that into valid rules: ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }
}
