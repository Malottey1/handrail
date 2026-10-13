import { redact } from "../redact.js";

export interface EmailMessage {
  to: { email: string; name: string };
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  /** Shown in settings, e.g. "Brevo (alerts@example.com)". */
  readonly description: string;
  send(message: EmailMessage): Promise<void>;
}

const TIMEOUT_MS = 15_000;

/**
 * Brevo's transactional email API (free tier: 300 emails a day). One request
 * per recipient, so approvers never see each other's addresses. The sender
 * address must be verified in Brevo.
 */
export class BrevoEmail implements EmailSender {
  readonly description: string;

  constructor(
    private readonly apiKey: string,
    private readonly from: { email: string; name: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.description = `Brevo (from ${from.email})`;
  }

  async send(message: EmailMessage): Promise<void> {
    const res = await this.fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: this.from,
        to: [message.to],
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
      const detail = typeof body?.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
      throw new Error(redact(`Brevo refused the email (HTTP ${res.status}${detail})`));
    }
  }
}

/**
 * Slack incoming webhooks only: an https URL on hooks.slack.com. Anything else
 * is refused, so the setting can't be used to make Handrail call arbitrary URLs.
 */
export function slackWebhookProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a URL. Paste the webhook URL Slack gave you (https://hooks.slack.com/services/…).";
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "hooks.slack.com" || !/^\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+$/.test(parsed.pathname)) {
    return "Use a Slack incoming webhook URL: https://hooks.slack.com/services/…";
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return "The webhook URL shouldn't have a query, fragment or credentials.";
  return null;
}

/** "hooks.slack.com/…/abcd": enough to recognise it, never enough to use it. */
export function maskSlackWebhook(url: string): string {
  return `hooks.slack.com/…/${url.slice(-4)}`;
}

export type SlackPoster = (url: string, payload: unknown) => Promise<void>;

export const postToSlack: SlackPoster = async (url, payload) => {
  const problem = slackWebhookProblem(url);
  if (problem) throw new Error(problem);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Slack refused the message (HTTP ${res.status})`);
};
