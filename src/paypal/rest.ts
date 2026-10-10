import type { PayPalTokenManager } from "./auth.js";

const TIMEOUT_MS = 8000;

/** Minimal read-only PayPal REST client, used to look up facts before a decision. */
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
}
