import { readFileSync } from "node:fs";
import { classifyTool } from "./classify.js";
import { policySchema, type Policy } from "./types.js";

/**
 * Parses and validates a policy. Beyond the schema, it rejects duplicate rule
 * ids and rules naming tools PayPal doesn't have, since a typo in a tool name
 * would otherwise silently switch a rule off.
 */
export function parsePolicy(input: unknown): Policy {
  const result = policySchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid policy:\n  ${issues.join("\n  ")}`);
  }

  const policy = result.data;
  const seen = new Set<string>();
  for (const rule of policy.rules) {
    if (seen.has(rule.id)) throw new Error(`Invalid policy: duplicate rule id "${rule.id}"`);
    seen.add(rule.id);
    for (const tool of rule.tools) {
      if (classifyTool(tool) === "unknown") {
        throw new Error(`Invalid policy: rule "${rule.id}" names unknown tool "${tool}"`);
      }
    }
  }
  return policy;
}

export function loadPolicyFile(path: string): Policy {
  return parsePolicy(JSON.parse(readFileSync(path, "utf8")));
}
