import { hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

/** Argon2id with the library's defaults (OWASP's recommended minimums). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

// Verified against when the email is unknown, so a miss takes as long as a wrong password.
let dummy: Promise<string> | null = null;

export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) {
    dummy ??= hash("handrail-dummy-password");
    await verify(await dummy, password).catch(() => false);
    return false;
  }
  return verify(stored, password).catch(() => false);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  return null;
}
