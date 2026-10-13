/**
 * Removes credentials from text before it leaves Handrail's process memory:
 * logs, error messages, results returned to agents, records in the audit log
 * and prompts sent to the AI. Two layers: the exact secrets Handrail was
 * configured with (registered at startup), and shapes of credentials anyone
 * might paste in (bearer headers, provider keys, PayPal tokens, agent keys).
 * Unit-tested in test/redact.test.ts; removing it from any of those paths
 * fails a test.
 */

export const REDACTED = "[redacted]";

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization header values: "Bearer <token>", "Basic <base64>".
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, `$1 ${REDACTED}`],
  // Anthropic and other "sk-" provider keys.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  // PayPal REST access tokens.
  [/\bA21AA[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Handrail agent keys.
  [/\bhr_agent_[A-Za-z0-9_-]{8,}/g, REDACTED],
  // key=value / "key": "value" pairs whose name says secret.
  [
    /((?:access_token|refresh_token|id_token|client_secret|api[_-]?key|password|secret)["']?\s*[:=]\s*["']?)[^"'\s,&}]{6,}/gi,
    `$1${REDACTED}`,
  ],
];

const secrets = new Set<string>();

/**
 * Registers configured secrets so they're redacted wherever they appear,
 * including the base64 form PayPal's token request uses. Values shorter than
 * 8 characters are ignored (too likely to match ordinary text).
 */
export function registerSecrets(...values: Array<string | undefined>): void {
  for (const v of values) if (v && v.length >= 8) secrets.add(v);
}

/** Registers the client id and secret, and their HTTP Basic encoding. */
export function registerClientCredentials(clientId: string, clientSecret: string): void {
  registerSecrets(clientId, clientSecret, Buffer.from(`${clientId}:${clientSecret}`).toString("base64"));
}

/** For tests. */
export function clearRegisteredSecrets(): void {
  secrets.clear();
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Redacts every string in a JSON-like value. Returns the same object when nothing changed. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) {
    const next = value.map(redactDeep);
    return (next.some((v, i) => v !== value[i]) ? next : value) as T;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactDeep(v);
      if (r !== v) changed = true;
      next[k] = r;
    }
    return (changed ? next : value) as T;
  }
  return value;
}
