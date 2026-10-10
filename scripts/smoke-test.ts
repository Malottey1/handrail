// Starts Handrail over stdio, acts as an agent: lists the tools, then makes one
// read-only call through the proxy. Run with: npm run smoke [-- <tool> '<json args>']
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Only tools that read data. The smoke test must never move money.
const READ_ONLY = /^(list|get|show|search)_/;
const PREFERRED = ["list_invoices", "list_products", "list_transactions", "list_disputes"];

const [toolArg, argsArg] = process.argv.slice(2);

const client = new Client({ name: "handrail-smoke-test", version: "0.1.0" });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts", "--stdio"],
      env: { ...getDefaultEnvironment(), ...(process.env as Record<string, string>) },
      stderr: "inherit",
    }),
  );
} catch {
  console.error("\nSMOKE TEST: Handrail failed to start (see its log above)");
  process.exit(1);
}

const { tools } = await client.listTools();
console.log(`\nHandrail exposes ${tools.length} tools:`);
for (const t of tools) console.log(`  - ${t.name}`);

let toolName = toolArg;
let args: Record<string, unknown> = argsArg ? JSON.parse(argsArg) : {};
if (!toolName) {
  // Pick a preferred read-only tool that needs no arguments.
  const noArgs = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    return tool && !(tool.inputSchema.required ?? []).length;
  };
  toolName = PREFERRED.find(noArgs) ?? "";
  args = {};
}

if (!toolName) {
  console.error("\nNo argument-free read-only tool found. Pass one: npm run smoke -- <tool> '<json args>'");
  process.exit(1);
}
if (!READ_ONLY.test(toolName)) {
  console.error(`\nRefusing to call ${toolName}: the smoke test only calls read-only tools.`);
  process.exit(1);
}

console.log(`\nCalling ${toolName} ${JSON.stringify(args)} through Handrail...`);
const result = await client.callTool({ name: toolName, arguments: args });
console.log(JSON.stringify(result, null, 2).slice(0, 3000));
console.log(result.isError ? "\nSMOKE TEST: tool returned an error (see above)" : "\nSMOKE TEST: ok");

await client.close();
process.exit(result.isError ? 1 : 0);
