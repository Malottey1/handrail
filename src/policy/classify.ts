import type { ToolClass } from "./types.js";

/**
 * Tools that move money out, give up money, or commit the merchant. Taken from
 * PayPal's sandbox MCP tool list (46 tools, Oct 2026).
 */
export const MONEY_TOOLS = new Set([
  "create_refund",
  "accept_dispute_claim",
  "cancel_sent_invoice",
  "cancel_subscription",
  "pay_order",
  "send_invoice",
  "record_refund_for_invoice",
  "cancel_recurring_series",
]);

export const READ_TOOLS = new Set([
  "list_invoices",
  "get_invoice",
  "search_invoicing",
  "get_recurring_series",
  "generate_invoice_qr_code",
  "generate_invoice_number",
  "list_products",
  "show_product_details",
  "list_subscription_plans",
  "show_subscription_plan_details",
  "show_subscription_details",
  "get_shipment_tracking",
  "get_order",
  "list_disputes",
  "get_dispute",
  "list_transactions",
  "get_refund",
  "get_merchant_insights",
]);

export const WRITE_TOOLS = new Set([
  "create_invoice",
  "create_recurring_series",
  "activate_recurring_series",
  "delete_recurring_series",
  "send_invoice_reminder",
  "delete_invoice",
  "setup_invoice_auto_reminders",
  "update_invoice_auto_reminder",
  "update_invoicing",
  "cancel_invoice_auto_reminder",
  "record_payment_for_invoice",
  "create_conditional_rules_for_invoice",
  "create_product",
  "update_product",
  "create_subscription_plan",
  "create_subscription",
  "update_subscription",
  "create_shipment_tracking",
  "update_shipment_tracking",
  "create_order",
]);

/** Tools PayPal adds later land in "unknown", which the default policy holds. */
export function classifyTool(tool: string): ToolClass {
  if (MONEY_TOOLS.has(tool)) return "money";
  if (READ_TOOLS.has(tool)) return "read";
  if (WRITE_TOOLS.has(tool)) return "write";
  return "unknown";
}
