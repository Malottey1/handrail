import { log } from "../log.js";
import type { PayPalRest } from "../paypal/rest.js";
import { toHundredths, type Money } from "./money.js";
import type { CallFacts, VerifiedFacts } from "./types.js";

interface PayPalAmount {
  currency_code?: string;
  value?: string;
}

interface Invoice {
  amount?: PayPalAmount;
  primary_recipients?: Array<{ billing_info?: { email_address?: string } }>;
}

function toMoney(amount: PayPalAmount | undefined): Money | null {
  if (!amount?.currency_code || typeof amount.value !== "string") return null;
  const hundredths = toHundredths(amount.value);
  return hundredths === null ? null : { hundredths, currency: amount.currency_code };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

// IDs go into URL paths, so only accept PayPal's ID alphabet.
const safeId = (v: unknown): string | null => {
  const s = str(v);
  return s && /^[A-Za-z0-9_-]{1,127}$/.test(s) ? s : null;
};

interface Order {
  id?: string;
  status?: string;
  purchase_units?: Array<{ amount?: PayPalAmount; payments?: { refunds?: Array<{ status?: string; amount?: PayPalAmount; links?: Link[] }> } }>;
  payer?: { payer_id?: string; email_address?: string; name?: { given_name?: string; surname?: string } };
  payment_source?: {
    paypal?: { email_address?: string; account_id?: string; name?: { given_name?: string; surname?: string } };
    card?: { name?: string; last_digits?: string; brand?: string };
  };
}

interface Link {
  rel?: string;
  href?: string;
}

const upId = (links: Link[] | undefined) => safeId(links?.find((l) => l.rel === "up")?.href?.split("/").pop());
const fullName = (n: { given_name?: string; surname?: string } | undefined) => str([n?.given_name, n?.surname].filter(Boolean).join(" "));

/** Who paid, as PayPal records it: their account, or for a card payment the cardholder. */
function payerOf(order: Order): VerifiedFacts["payer"] {
  const pp = order.payment_source?.paypal;
  const card = order.payment_source?.card;
  const payer = {
    id: str(order.payer?.payer_id) ?? str(pp?.account_id),
    email: str(order.payer?.email_address) ?? str(pp?.email_address),
    name: fullName(order.payer?.name) ?? fullName(pp?.name) ?? str(card?.name),
    card: card ? `${card.brand ?? "Card"} ending ${card.last_digits ?? "????"}` : null,
  };
  return payer.id || payer.email || payer.name || payer.card ? payer : undefined;
}

/** Refunds PayPal recorded (completed or pending) on one capture and on the whole order. */
function refundsOf(order: Order, captureId: string | null): VerifiedFacts["refunds"] {
  const counted = (order.purchase_units ?? []).flatMap((u) => u.payments?.refunds ?? []).filter((r) => r.status === "COMPLETED" || r.status === "PENDING");
  const total = (list: typeof counted) => (list.length ? sumSameCurrency(list.map((r) => toMoney(r.amount))) : null);
  const onCapture = counted.filter((r) => upId(r.links) === captureId);
  // null with refunds present means mixed or unreadable currencies: the engine fails closed on it.
  return {
    capture: onCapture.length ? total(onCapture) : null,
    order: counted.length ? total(counted) : null,
    count: counted.length,
  };
}

/** "PayPal lookup failed (HTTP 404)": the status only, never the response body. */
function lookupError(err: unknown): string {
  const status = /HTTP (\d{3})/.exec((err as Error)?.message ?? "")?.[1];
  return status ? `PayPal lookup failed (HTTP ${status})` : "PayPal lookup failed (no response)";
}

/**
 * Works out how much money a call moves, who the counterparty is, and what
 * PayPal itself says about the object (`verified`): the capture and order,
 * the payer, refunds already made, a dispute's status and deadline. Agents
 * often omit the amount (a refund with no amount refunds the whole capture;
 * a capture or dispute acceptance names only an ID), so the real value is
 * looked up with read-only REST calls. Anything that can't be determined is
 * left null, and the policy engine fails closed on it. Nothing in `verified`
 * comes from the agent's arguments.
 */
export async function resolveFacts(tool: string, args: Record<string, unknown>, rest: PayPalRest): Promise<CallFacts> {
  const facts: CallFacts = { tool, args, amount: null, amountSource: "none", payee: null };

  const fromArgs = toMoney(args.amount as PayPalAmount | undefined);
  if (fromArgs) {
    facts.amount = fromArgs;
    facts.amountSource = "arguments";
  }

  const verified: VerifiedFacts = { source: "paypal" };
  try {
    switch (tool) {
      case "create_refund": {
        const id = safeId(args.capture_id);
        if (!id) {
          verified.source = "unavailable";
          verified.error = "No capture id to look up";
          break;
        }
        const capture = await rest.get<{ id?: string; status?: string; amount?: PayPalAmount; links?: Link[]; supplementary_data?: { related_ids?: { order_id?: string } } }>(
          `/v2/payments/captures/${id}`,
        );
        verified.capture = { id, status: str(capture.status), amount: toMoney(capture.amount) };
        // No amount means a full refund: the capture amount is the upper bound.
        if (!facts.amount) setLookedUp(facts, verified.capture.amount);
        const orderId = safeId(capture.supplementary_data?.related_ids?.order_id) ?? upId(capture.links);
        if (orderId) {
          try {
            const order = await rest.get<Order>(`/v2/checkout/orders/${orderId}`);
            verified.order = { id: orderId, status: str(order.status), amount: sumSameCurrency((order.purchase_units ?? []).map((u) => toMoney(u.amount))) };
            verified.payer = payerOf(order);
            verified.refunds = refundsOf(order, id);
          } catch (err) {
            // The capture is verified; the order (payer, earlier refunds) isn't.
            verified.error = `${lookupError(err)} for the order`;
          }
        }
        break;
      }
      case "pay_order": {
        const id = safeId(args.id);
        if (!id) break;
        const order = await rest.get<Order>(`/v2/checkout/orders/${id}`);
        const amount = sumSameCurrency((order.purchase_units ?? []).map((u) => toMoney(u.amount)));
        setLookedUp(facts, amount);
        verified.order = { id, status: str(order.status), amount };
        verified.payer = payerOf(order);
        break;
      }
      case "accept_dispute_claim": {
        const id = safeId(args.dispute_id);
        if (!id) break;
        const dispute = await rest.get<{
          status?: string;
          reason?: string;
          dispute_life_cycle_stage?: string;
          dispute_amount?: PayPalAmount;
          seller_response_due_date?: string;
          disputed_transactions?: Array<{ buyer?: { name?: string; email?: string } }>;
        }>(`/v1/customer/disputes/${id}`);
        setLookedUp(facts, toMoney(dispute.dispute_amount));
        verified.dispute = {
          id,
          status: str(dispute.status),
          reason: str(dispute.reason),
          stage: str(dispute.dispute_life_cycle_stage),
          amount: toMoney(dispute.dispute_amount),
          respondBy: str(dispute.seller_response_due_date),
        };
        const buyer = dispute.disputed_transactions?.[0]?.buyer;
        if (buyer?.name || buyer?.email) verified.payer = { id: null, email: str(buyer.email), name: str(buyer.name), card: null };
        break;
      }
      case "send_invoice":
      case "cancel_sent_invoice":
      case "record_refund_for_invoice": {
        const id = safeId(args.invoice_id);
        if (!id) break;
        const invoice = await rest.get<Invoice & { status?: string }>(`/v2/invoicing/invoices/${id}`);
        if (!facts.amount) setLookedUp(facts, toMoney(invoice.amount));
        facts.payee = str(invoice.primary_recipients?.[0]?.billing_info?.email_address);
        verified.invoice = { id, status: str(invoice.status), amount: toMoney(invoice.amount), recipient: facts.payee };
        break;
      }
      case "cancel_subscription": {
        const id = safeId(args.subscription_id);
        if (!id) break;
        const sub = await rest.get<{ status?: string; plan_id?: string; subscriber?: { email_address?: string } }>(`/v1/billing/subscriptions/${id}`);
        verified.subscription = { id, status: str(sub.status), plan: str(sub.plan_id), subscriber: str(sub.subscriber?.email_address) };
        facts.payee = verified.subscription.subscriber;
        break;
      }
      default:
        return facts; // nothing to verify
    }
  } catch (err) {
    // Fail closed: leave the unknowns null and let the engine hold the call.
    log(`Fact lookup for ${tool} failed: ${(err as Error).message}`);
    verified.source = "unavailable";
    verified.error = lookupError(err);
  }
  if (verified.source === "paypal" && !verified.capture && !verified.order && !verified.dispute && !verified.invoice && !verified.subscription) {
    verified.source = "unavailable";
    verified.error ??= "Nothing to look up: the call names no PayPal object";
  }
  facts.verified = verified;
  return facts;
}

function setLookedUp(facts: CallFacts, amount: Money | null): void {
  if (amount) {
    facts.amount = amount;
    facts.amountSource = "lookup";
  }
}

function sumSameCurrency(amounts: Array<Money | null>): Money | null {
  if (amounts.length === 0 || amounts.some((a) => a === null)) return null;
  const currency = amounts[0]!.currency;
  if (amounts.some((a) => a!.currency !== currency)) return null;
  return { currency, hundredths: amounts.reduce((sum, a) => sum + a!.hundredths, 0) };
}
