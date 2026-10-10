import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { CallLog } from "./audit.js";
import { log } from "./log.js";
import type { PayPalRest } from "./paypal/rest.js";
import { EVENT_RULES, matchEvent, parseForwardedCall, type WebhookEvent, type WebhookStore } from "./webhooks.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MATCH_WINDOW_MS = 30 * 24 * 3600 * 1000;

export interface WebhookDeps {
  rest: PayPalRest;
  callLog: CallLog;
  store: WebhookStore;
  /** From the PayPal dashboard. Unset disables the endpoint. */
  webhookId: string | undefined;
  /** Sandbox testing only: accept events whose signature can't be verified (e.g. the dashboard simulator). */
  allowUnverified: boolean;
}

/**
 * Asks PayPal whether this delivery really came from PayPal for our webhook.
 * https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature_post
 */
async function verifySignature(rest: PayPalRest, headers: IncomingHttpHeaders, event: unknown, webhookId: string): Promise<boolean> {
  const header = (name: string) => (Array.isArray(headers[name]) ? headers[name]![0] : headers[name]) as string | undefined;
  const required = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
  if (required.some((h) => !header(h))) return false;
  try {
    const result = await rest.post<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", {
      auth_algo: header("paypal-auth-algo"),
      cert_url: header("paypal-cert-url"),
      transmission_id: header("paypal-transmission-id"),
      transmission_sig: header("paypal-transmission-sig"),
      transmission_time: header("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    });
    return result.verification_status === "SUCCESS";
  } catch (err) {
    log(`Webhook signature check failed: ${(err as Error).message}`);
    return false;
  }
}

async function readRaw(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/**
 * POST /webhooks/paypal: verifies the event, matches it to the agent call that
 * caused it, and stores the result. Answers 2xx for anything stored or
 * deliberately ignored so PayPal doesn't keep redelivering it.
 */
export async function handleWebhook(req: IncomingMessage, res: ServerResponse, deps: WebhookDeps): Promise<void> {
  if (!deps.webhookId) {
    send(res, 503, { error: "Webhooks disabled: set PAYPAL_WEBHOOK_ID in .env" });
    return;
  }

  const raw = await readRaw(req);
  if (raw === null) return send(res, 413, { error: "Body too large" });

  let event: WebhookEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: "Body must be JSON" });
  }
  if (typeof event?.id !== "string" || typeof event.event_type !== "string") {
    return send(res, 400, { error: "Not a PayPal webhook event" });
  }

  if (deps.store.has(event.id)) {
    return send(res, 200, { ok: true, duplicate: true });
  }

  const verified = await verifySignature(deps.rest, req.headers, event, deps.webhookId);
  if (!verified && !deps.allowUnverified) {
    log(`Webhook ${event.id} (${event.event_type}) rejected: signature not verified`);
    return send(res, 400, { error: "Signature verification failed" });
  }

  const rule = EVENT_RULES[event.event_type];
  const calls = rule ? deps.callLog.forwardedCalls(rule.tool, Date.now() - MATCH_WINDOW_MS).map(parseForwardedCall) : [];
  const match = matchEvent(event, calls);
  deps.store.insert(event, verified, match, raw, Date.now());

  const flag = match.status === "mismatch" || match.status === "outside_handrail" ? " FLAGGED" : "";
  log(
    `Webhook ${event.event_type} ${match.resourceId ?? ""} -> ${match.status}${flag}` +
      `${match.callId ? ` (call #${match.callId})` : ""}${verified ? "" : " [UNVERIFIED]"}` +
      `${match.reasons.length ? `: ${match.reasons.join("; ")}` : ""}`,
  );
  send(res, 200, { ok: true, status: match.status });
}
