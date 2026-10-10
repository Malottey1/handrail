// Fires the same refund many times at once through Handrail, like an agent
// stuck in a retry loop, and shows that PayPal receives it once.
//
//   npm run demo:retry-storm
//   npm run demo:retry-storm -- --capture <capture_id> --amount 5.00 --count 10
//
// The default capture ID doesn't exist, so PayPal answers "not found" and no
// money moves. With a real sandbox capture, exactly one refund is created.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const { values } = parseArgs({
  options: {
    capture: { type: "string", default: "HANDRAILDEMO00000001" },
    amount: { type: "string", default: "5.00" },
    count: { type: "string", default: "10" },
  },
});
const count = Math.max(2, Math.min(Number(values.count) || 10, 50));

const token = process.env.HANDRAIL_ADMIN_TOKEN?.trim() || randomBytes(24).toString("hex");
const api = `http://127.0.0.1:${Number(process.env.PORT) || 8787}/api`;

const client = new Client({ name: "handrail-retry-storm", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts", "--stdio"],
    env: { ...getDefaultEnvironment(), ...(process.env as Record<string, string>), HANDRAIL_ADMIN_TOKEN: token },
    stderr: "inherit",
  }),
);

// A unique note makes this run's refund a new operation, so reruns aren't
// answered from an earlier run's stored result.
const args = {
  capture_id: values.capture,
  amount: { currency_code: "USD", value: values.amount },
  note_to_payer: `Handrail retry storm ${new Date().toISOString()}`,
};

console.log(`\n=== Sending ${count} identical create_refund calls at once\n>>> ${JSON.stringify(args)}\n`);
const started = Date.now();
const results = (await Promise.all(
  Array.from({ length: count }, () => client.callTool({ name: "create_refund", arguments: args })),
)) as CallToolResult[];

const firstLine = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const duplicates = results.filter((r) => firstLine(r).startsWith("[Handrail] Duplicate")).length;
console.log(`\n=== ${count} calls answered in ${Date.now() - started}ms: ${count - duplicates} sent to PayPal, ${duplicates} answered as duplicates`);
const original = results.find((r) => !firstLine(r).startsWith("[Handrail] Duplicate"));
if (original) console.log(`PayPal's answer (shared by all ${count}):\n${firstLine(original).slice(0, 600)}`);

const calls = (await (await fetch(`${api}/calls?limit=${count}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Array<
  Record<string, unknown>
>;
console.log("\n=== Call log for this run (newest first)");
for (const c of calls) {
  console.log(`#${c.id} decision=${c.decision} forwarded=${c.forwarded} outcome=${c.outcome} request_id=${c.request_id ?? "-"}`);
}

await client.close();
