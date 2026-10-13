#!/usr/bin/env node
// Blocks secrets from being committed. Plain JavaScript with no dependencies,
// so the pre-commit hook and CI can run it before `npm install`.
//
//   node scripts/check-secrets.mjs            staged changes (the pre-commit hook)
//   node scripts/check-secrets.mjs --all      every tracked file (CI, npm run check:secrets)
//
// Checks credential shapes, files that must never be committed (.env, databases,
// keys), and the exact secret values in your local .env. It prints where a
// secret is and which rule matched, never the secret itself.
// A line that is a deliberate fake can end with the comment "secret-scan: allow".

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PATTERNS = [
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["PayPal access token", /\bA21AA[A-Za-z0-9_-]{40,}/],
  ["Handrail agent key", /\bhr_agent_[A-Za-z0-9_-]{20,}/],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
  ["Basic auth credentials", /\bBasic\s+[A-Za-z0-9+/]{30,}={0,2}/],
  ["Private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Secret in an env assignment", /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD)[A-Z0-9_]*\s*=\s*["']?[A-Za-z0-9_\-/+=.]{16,}/],
];

// Paths that must never be committed, whatever they contain.
const FORBIDDEN_PATHS = [
  [/(^|\/)\.env(\..+)?$/, (p) => !p.endsWith(".env.example"), "an env file"],
  [/(^|\/)\.envrc$/, () => true, "an env file"],
  [/\.(db|sqlite|sqlite3)(-journal|-wal|-shm)?$/, () => true, "a database"],
  [/\.(pem|key|p12|pfx)$/, () => true, "a key file"],
];

const ALLOW = "secret-scan: allow";

/** The secret values in the local .env (never printed). */
function localSecrets() {
  if (!existsSync(".env")) return [];
  const out = [];
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !/SECRET|TOKEN|KEY|CLIENT_ID|WEBHOOK_ID|PASSWORD/.test(m[1])) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value.length >= 8) out.push([m[1], value]);
  }
  return out;
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** [path, [[lineNumber, text]]] for what's being checked. */
function targets(all) {
  if (all) {
    return git("ls-files", "-z")
      .split("\0")
      .filter(Boolean)
      .map((path) => {
        let text = "";
        try {
          text = readFileSync(path, "utf8");
        } catch {
          // Deleted in the working tree.
        }
        return [path, text.split("\n").map((t, i) => [i + 1, t])];
      });
  }
  // Added lines of staged changes only.
  const files = new Map();
  let path = null;
  let line = 0;
  for (const l of git("diff", "--cached", "--unified=0", "--no-color", "--diff-filter=ACMR").split("\n")) {
    if (l.startsWith("+++ ")) {
      path = l.slice(4).replace(/^b\//, "");
      files.set(path, []);
    } else if (l.startsWith("@@")) {
      line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    } else if (path && l.startsWith("+")) {
      files.get(path).push([line++, l.slice(1)]);
    }
  }
  // Binary and empty files have no added lines but must still pass the path check.
  for (const p of git("diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR").split("\0").filter(Boolean)) {
    if (!files.has(p)) files.set(p, []);
  }
  return [...files];
}

function isBinary(lines) {
  return lines.some(([, t]) => t.includes("\0"));
}

const all = process.argv.includes("--all");
const secrets = localSecrets();
const problems = [];

for (const [path, lines] of targets(all)) {
  for (const [re, applies, what] of FORBIDDEN_PATHS) {
    if (re.test(path) && applies(path)) problems.push(`${path}: this is ${what}, which must never be committed`);
  }
  if (isBinary(lines)) continue;
  for (const [n, text] of lines) {
    if (text.includes(ALLOW)) continue;
    for (const [name, re] of PATTERNS) if (re.test(text)) problems.push(`${path}:${n}: possible ${name}`);
    for (const [name, value] of secrets) if (text.includes(value)) problems.push(`${path}:${n}: contains the value of ${name} from your .env`);
  }
}

if (problems.length) {
  console.error(`Secret check failed (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nRemove the secret (and rotate it if it was real). The value itself is never printed.");
  console.error(`If it's a deliberate fake, end the line with the comment "${ALLOW}".`);
  process.exit(1);
}
console.error(`Secret check passed (${all ? "all tracked files" : "staged changes"}).`);
