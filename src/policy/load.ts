import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

/**
 * If the policy file doesn't exist yet (a fresh deploy with HANDRAIL_POLICY_PATH
 * on an empty disk, or no disk), copies the committed default there, so
 * Handrail always starts with the demo-ready rules. Never overwrites a file.
 * Returns true if it seeded one.
 */
export function seedPolicyFile(path: string, defaultPath: string): boolean {
  if (existsSync(path) || resolve(path) === resolve(defaultPath)) return false;
  loadPolicyFile(defaultPath); // refuse to seed from an invalid default
  mkdirSync(dirname(resolve(path)), { recursive: true });
  try {
    copyFileSync(defaultPath, path, constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; // another process got there first
    throw err;
  }
  return true;
}
