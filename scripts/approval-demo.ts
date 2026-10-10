// End-to-end check of the policy and approval flow against the PayPal sandbox.
// Acts as an agent: starts Handrail over stdio and makes four calls.
//
//   npm run demo:approval                  you approve/reject in another terminal
//   npm run demo:approval -- --auto        the script approves/rejects itself
//
// The refunds target a capture ID that doesn't exist, so PayPal answers
// "not found" and no money can move.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const auto = process.argv.includes("--auto");
const FAKE_CAPTURE = "HANDRAILDEMO00000001";
const FAKE_DISPUTE = "PP-D-HANDRAILDEMO1";

// Without a configured token, use a throwaway one shared with the child process.
const token = process.env.HANDRAIL_ADMIN_TOKEN?.trim() || randomBytes(24).toString("hex");
const api = `http://127.0.0.1:${Number(process.env.PORT) || 8787}/api`;

const client = new Client({ name: "handrail-approval-demo", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts", "--stdio"],
    env: { ...getDefaultEnvironment(), ...(process.env as Record<string, string>), HANDRAIL_ADMIN_TOKEN: token },
    stderr: "inherit",
  }),
);

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

async function adminDecideFirstPending(action: "approve" | "reject", note: string): Promise<void> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  for (let i = 0; i < 20; i++) {
    const pending = (await (await fetch(`${api}/approvals?status=pending`, { headers })).json()) as Array<{ id: string }>;
    if (pending[0]) {
      await fetch(`${api}/approvals/${pending[0].id}/${action}`, { method: "POST", headers, body: JSON.stringify({ by: "demo-script", note }) });
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function step(title: string, tool: string, args: Record<string, unknown>, decide?: { action: "approve" | "reject"; note: string }) {
  console.log(`\n=== ${title}\n>>> ${tool} ${JSON.stringify(args)}`);
  if (decide && auto) setTimeout(() => void adminDecideFirstPending(decide.action, decide.note), 1500);
  if (decide && !auto) console.log(`(held for approval: run "npm run approvals" in another terminal, then ${decide.action} it)`);
  const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  console.log(`<<< isError=${result.isError === true}\n${text(result).slice(0, 1200)}`);
}

await step("1. Small refund: allowed, forwarded to PayPal", "create_refund", {
  capture_id: FAKE_CAPTURE,
  amount: { currency_code: "USD", value: "50.00" },
});
await step(
  "2. Refund over $100: held, then approved",
  "create_refund",
  { capture_id: FAKE_CAPTURE, amount: { currency_code: "USD", value: "250.00" } },
  { action: "approve", note: "customer verified" },
);
await step("3. Refund over $1,000: blocked, never reaches PayPal", "create_refund", {
  capture_id: FAKE_CAPTURE,
  amount: { currency_code: "USD", value: "5000.00" },
});
await step(
  "4. Accepting a dispute: held, then rejected",
  "accept_dispute_claim",
  { dispute_id: FAKE_DISPUTE, note: "demo" },
  { action: "reject", note: "we have proof of delivery" },
);

const calls = (await (await fetch(`${api}/calls?limit=5`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Array<
  Record<string, unknown>
>;
console.log("\n=== Call log (newest first)");
for (const c of calls) {
  console.log(`#${c.id} ${c.tool} decision=${c.decision} forwarded=${c.forwarded} error=${c.is_error} approval=${c.approval_id ?? "-"}`);
}

await client.close();
