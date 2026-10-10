import type { PayPalTokenManager } from "./auth.js";

const TIMEOUT_MS = 8000;

/**
 * Minimal PayPal REST client for reads (fact lookups) and webhook signature
 * verification. Money-moving calls never go through here.
 */
export class PayPalRest {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: PayPalTokenManager,
  ) {}

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${await this.tokens.getToken()}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GET ${path} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.tokens.getToken()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`POST ${path} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }
}
