import { log } from "../log.js";

/** Refresh this long before PayPal says the token expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Holds a PayPal access token obtained with the OAuth client-credentials flow
 * and refreshes it before expiry. The token itself is never logged.
 */
export class PayPalTokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return this.token;
    }
    // Single-flight: concurrent callers share one refresh request.
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });

    if (!res.ok) {
      // PayPal's error body (e.g. invalid_client) contains no secrets.
      const body = await res.text();
      throw new Error(`PayPal token request failed: HTTP ${res.status} ${body}`);
    }

    const data = (await res.json()) as TokenResponse;
    this.token = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    log(`Obtained PayPal access token (expires in ${Math.round(data.expires_in / 60)} min)`);
    return this.token;
  }
}
