import { log } from "../log.js";
import type { PayPalRest } from "../paypal/rest.js";
import { toHundredths, type Money } from "./money.js";
import type { CallFacts } from "./types.js";

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

/**
 * Works out how much money a call moves and who the counterparty is. Agents
 * often omit the amount (a refund with no amount refunds the whole capture;
 * a capture or dispute acceptance names only an ID), so the real value is
 * looked up with read-only REST calls. Anything that can't be determined is
 * left null, and the policy engine fails closed on it.
 */
export async function resolveFacts(tool: string, args: Record<string, unknown>, rest: PayPalRest): Promise<CallFacts> {
  const facts: CallFacts = { tool, args, amount: null, amountSource: "none", payee: null };

  const fromArgs = toMoney(args.amount as PayPalAmount | undefined);
  if (fromArgs) {
    facts.amount = fromArgs;
    facts.amountSource = "arguments";
  }

  try {
    switch (tool) {
      case "create_refund": {
        // No amount means a full refund: the capture amount is the upper bound.
        const id = safeId(args.capture_id);
        if (!facts.amount && id) {
          const capture = await rest.get<{ amount?: PayPalAmount }>(`/v2/payments/captures/${id}`);
          setLookedUp(facts, toMoney(capture.amount));
        }
        break;
      }
      case "pay_order": {
        const id = safeId(args.id);
        if (id) {
          const order = await rest.get<{ purchase_units?: Array<{ amount?: PayPalAmount }> }>(`/v2/checkout/orders/${id}`);
          setLookedUp(facts, sumSameCurrency((order.purchase_units ?? []).map((u) => toMoney(u.amount))));
        }
        break;
      }
      case "accept_dispute_claim": {
        const id = safeId(args.dispute_id);
        if (id) {
          const dispute = await rest.get<{ dispute_amount?: PayPalAmount }>(`/v1/customer/disputes/${id}`);
          setLookedUp(facts, toMoney(dispute.dispute_amount));
        }
        break;
      }
      case "send_invoice":
      case "cancel_sent_invoice":
      case "record_refund_for_invoice": {
        const id = safeId(args.invoice_id);
        if (id) {
          const invoice = await rest.get<Invoice>(`/v2/invoicing/invoices/${id}`);
          if (!facts.amount) setLookedUp(facts, toMoney(invoice.amount));
          facts.payee = str(invoice.primary_recipients?.[0]?.billing_info?.email_address);
        }
        break;
      }
    }
  } catch (err) {
    // Fail closed: leave the unknowns null and let the engine hold the call.
    log(`Fact lookup for ${tool} failed: ${(err as Error).message}`);
  }

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
