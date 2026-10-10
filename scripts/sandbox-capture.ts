// Creates a real sandbox payment to test refunds against.
//
//   npm run sandbox:capture [-- --amount 20.00]
//
// 1. Creates a sandbox order (setup step, straight to the REST API).
// 2. Prints a link: approve it while logged in as your sandbox *buyer* account.
// 3. Captures the order through Handrail as an agent would (pay_order).
// 4. Prints the capture ID for: npm run demo:retry-storm -- --capture <id>
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { PayPalTokenManager } from "../src/paypal/auth.js";
import { PayPalRest } from "../src/paypal/rest.js";

const { values } = parseArgs({ options: { amount: { type: "string", default: "20.00" } } });

const config = loadConfig();
const rest = new PayPalRest(config.paypalBaseUrl, new PayPalTokenManager(config.paypalBaseUrl, config.paypalClientId, config.paypalClientSecret));

interface Order {
  id: string;
  status: string;
  links?: Array<{ rel: string; href: string }>;
}

const order = await rest.post<Order>("/v2/checkout/orders", {
  intent: "CAPTURE",
  purchase_units: [{ amount: { currency_code: "USD", value: values.amount }, description: "Handrail sandbox test order" }],
  payment_source: {
    paypal: {
      experience_context: {
        user_action: "PAY_NOW",
        return_url: "https://example.com/handrail/approved",
        cancel_url: "https://example.com/handrail/cancelled",
      },
    },
  },
});
const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;

console.log(`\nCreated sandbox order ${order.id} for ${values.amount} USD.`);
console.log(`\n1. Open this link and log in with your sandbox BUYER (Personal) account, then approve:\n\n   ${approveUrl}\n`);
console.log("   (After approving, PayPal sends you to example.com. That's expected; come back here.)\n");
console.log("Waiting for approval...");

const deadline = Date.now() + 15 * 60_000;
for (;;) {
  const current = await rest.get<Order>(`/v2/checkout/orders/${order.id}`);
  if (current.status === "APPROVED") break;
  if (Date.now() > deadline) {
    console.error(`Gave up after 15 minutes; order is ${current.status}.`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log("Approved. Capturing through Handrail (pay_order)...\n");

const client = new Client({ name: "handrail-sandbox-capture", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts", "--stdio"],
    env: {
      ...getDefaultEnvironment(),
      ...(process.env as Record<string, string>),
      HANDRAIL_ADMIN_TOKEN: process.env.HANDRAIL_ADMIN_TOKEN?.trim() || randomBytes(24).toString("hex"),
    },
    stderr: "inherit",
  }),
);
const result = (await client.callTool({ name: "pay_order", arguments: { id: order.id } })) as CallToolResult;
await client.close();

const text = (result.content.at(-1) as { text: string }).text;
let captureId: string | undefined;
try {
  captureId = JSON.parse(text)?.response?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
} catch {
  // Not PayPal JSON: printed below.
}

if (!captureId) {
  console.error(`\nCapture didn't return a capture ID:\n${result.content.map((c) => (c as { text: string }).text).join("\n").slice(0, 1500)}`);
  process.exit(1);
}
console.log(`\nCaptured. Capture ID: ${captureId}\n\nNext, refund it with a retry storm:\n\n   npm run demo:retry-storm -- --capture ${captureId} --amount 5.00\n`);
