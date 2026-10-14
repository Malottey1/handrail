/*!
 * Contains material from PayPal's Agent Toolkit (https://github.com/paypal/agent-toolkit, typescript/src/shared/tools.ts),
 * Copyright 2025 PayPal, licensed under the Apache License, Version 2.0
 * (https://www.apache.org/licenses/LICENSE-2.0; see LICENSES/Apache-2.0.txt in Handrail's repo).
 * Modified for Handrail, 2026: only the tool to action-name table is kept, plus ALL_TOOLS_ENABLED built from it.
 */
// Which configuration.actions entries enable each tool. The same action names
// select the same tools as PayPal's PayPalAgentToolkit.

export type Actions = { [product: string]: { [action: string]: boolean } };

export const TOOL_ACTIONS: Record<string, Actions> = {
  accept_dispute_claim: {disputes: {create: true}},
  activate_recurring_series: {invoices: {activateRecurringSeries: true}},
  cancel_invoice_auto_reminder: {invoices: {cancelReminders: true}},
  cancel_recurring_series: {invoices: {cancelRecurringSeries: true}},
  cancel_sent_invoice: {invoices: {cancel: true}},
  cancel_subscription: {subscriptions: {cancel: true}},
  create_conditional_rules_for_invoice: {invoices: {createConditionalRules: true}},
  create_invoice: {invoices: {create: true}},
  create_order: {orders: {create: true}},
  create_product: {products: {create: true}},
  create_recurring_series: {invoices: {createRecurringSeries: true}},
  create_refund: {payments: {createRefund: true}},
  create_shipment_tracking: {shipment: {create: true}},
  create_subscription: {subscriptions: {create: true}},
  create_subscription_plan: {subscriptionPlans: {create: true}},
  delete_invoice: {invoices: {delete: true}},
  delete_recurring_series: {invoices: {deleteRecurringSeries: true}},
  generate_invoice_number: {invoices: {generateInvoiceNumber: true}},
  generate_invoice_qr_code: {invoices: {generateQRC: true}},
  get_dispute: {disputes: {get: true}},
  get_invoice: {invoices: {get: true}},
  get_merchant_insights: {insights: {get: true}},
  get_order: {orders: {get: true}},
  get_recurring_series: {invoices: {getRecurringSeries: true}},
  get_refund: {payments: {getRefunds: true}},
  get_shipment_tracking: {shipment: {get: true}},
  list_disputes: {disputes: {list: true}},
  list_invoices: {invoices: {list: true}},
  list_products: {products: {list: true}},
  list_subscription_plans: {subscriptionPlans: {list: true}},
  list_transactions: {transactions: {list: true}},
  pay_order: {orders: {capture: true}},
  record_payment_for_invoice: {invoices: {recordPayment: true}},
  record_refund_for_invoice: {invoices: {recordRefund: true}},
  search_invoicing: {invoices: {search: true}},
  send_invoice: {invoices: {send: true}},
  send_invoice_reminder: {invoices: {sendReminder: true}},
  setup_invoice_auto_reminders: {invoices: {setupReminders: true}},
  show_product_details: {products: {show: true}},
  show_subscription_details: {subscriptions: {show: true}},
  show_subscription_plan_details: {subscriptionPlans: {show: true}},
  update_invoice_auto_reminder: {invoices: {updateReminder: true}},
  update_invoicing: {invoices: {update: true}},
  update_plan: {plan: {update: true}},
  update_product: {products: {update: true}},
  update_shipment_tracking: {shipment: {update: true}},
  update_subscription: {subscriptions: {update: true}},
};

/** Every action enabled, like PayPal's ALL_TOOLS_ENABLED. */
export const ALL_TOOLS_ENABLED: Actions = Object.values(TOOL_ACTIONS).reduce<Actions>((all, actions) => {
  for (const [product, acts] of Object.entries(actions)) all[product] = { ...all[product], ...acts };
  return all;
}, {});
