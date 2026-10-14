// Runs the three switched examples with a real LLM against a throwaway Handrail
// and PayPal's sandbox, and records what each agent told the user and whether it
// retried the held refund.
//
//   npm run real-model-run                 all three
//   npm run real-model-run -- python       or: ai-sdk, langchain-js
//
// Needs in .env: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox; used only by
// this Handrail and to make the test sales, never given to the examples) and
// OPENAI_API_KEY (PayPal's examples use gpt-4o). Each run makes one real
// sandbox sale per example and a few OpenAI calls.
//
// The examples get only HANDRAIL_URL, HANDRAIL_AGENT_KEY and CAPTURE_ID. Handrail
// runs with its own temporary database, a random agent key and admin token, no AI
// briefs and no alerts. The report goes to real-model-runs/<time>.md.
import "dotenv/config";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoSale } from "../src/demo/sale.js";
import { PayPalTokenManager } from "../src/paypal/auth.js";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 8795;
const URL_ = `http://127.0.0.1:${PORT}`;
const SANDBOX = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 6 * 60_000;

type Example = { id: string; title: string; cwd: string; command: string[] };
const PYTHON = process.env.EXAMPLES_PYTHON || (existsSync(join(ROOT, ".venv-examples/bin/python")) ? join(ROOT, ".venv-examples/bin/python") : "python3");
const EXAMPLES: Example[] = [
  { id: "python", title: "Python LangChain (examples/python/langchain/app_agent.py)", cwd: "examples/python/langchain", command: [PYTHON, "app_agent.py"] },
  { id: "ai-sdk", title: "TypeScript AI SDK (examples/typescript/ai-sdk/index.ts)", cwd: "examples/typescript/ai-sdk", command: ["npx", "tsx", "index.ts"] },
  { id: "langchain-js", title: "TypeScript LangChain (examples/typescript/langchain/index.ts)", cwd: "examples/typescript/langchain", command: ["npx", "tsx", "index.ts"] },
];

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name} in .env. Add it and run again.`);
    process.exit(1);
  }
  return value;
}

function run(cmd: string[], opts: { cwd: string; env: Record<string, string> }): Promise<{ code: number | null; output: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    // A minimal environment: the examples never see PayPal credentials or anything else from .env.
    const base = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "USER", "SHELL", "TERM"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd: join(ROOT, opts.cwd), env: { ...base, ...opts.env } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, ms: Date.now() - started });
    });
  });
}

/** The last thing the agent said to the user, as each example prints it. */
function finalWords(id: string, output: string): string {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (id === "python") return clean.match(/Agent Output:([\s\S]*)$/)?.[1]?.trim() ?? "(not found: see the full output)";
  const tail = () => `(couldn't pick it out; the end of the output was:)\n${clean.trim().slice(-1500)}`;
  if (id === "ai-sdk") {
    // The example logs "Response 4: \n<summary>", prints the summary again, then prints the refund answer.
    const at = clean.lastIndexOf("Response 4: \n");
    if (at < 0) return tail();
    const rest = clean.slice(at + "Response 4: \n".length).replace(/\s+$/, "");
    for (let l = 1; 2 * l + 1 < rest.length; l++) {
      if (rest[l] === "\n" && rest.slice(0, l) === rest.slice(l + 1, 2 * l + 1)) return rest.slice(2 * l + 2).trim() || tail();
    }
    return tail();
  }
  // LangChain JS prints the whole result; the last AIMessage's content is the answer.
  const contents = [...clean.matchAll(/AIMessage \{[\s\S]*?content: (['"`])([\s\S]*?)\1,/g)].map((m) => m[2]!);
  return contents.at(-1)?.replace(/\\n/g, "\n").trim() || tail();
}

async function main() {
  const only = process.argv[2];
  const examples = only ? EXAMPLES.filter((e) => e.id === only) : EXAMPLES;
  if (examples.length === 0) throw new Error(`Unknown example ${only}. Use python, ai-sdk or langchain-js.`);
  const paypalId = need("PAYPAL_CLIENT_ID");
  const paypalSecret = need("PAYPAL_CLIENT_SECRET");
  const openaiKey = need("OPENAI_API_KEY");
  for (const e of examples) {
    if (e.id !== "python" && !existsSync(join(ROOT, e.cwd, "node_modules"))) {
      throw new Error(`Install the example first: (cd ${e.cwd} && npm install --install-links)`);
    }
  }

  const agentKey = randomBytes(24).toString("hex");
  const adminToken = randomBytes(24).toString("hex");
  const dir = mkdtempSync(join(tmpdir(), "handrail-real-model-"));
  console.log(`Starting a throwaway Handrail on ${URL_} (database in ${dir})…`);
  const server = spawn("node", ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HANDRAIL_DB_PATH: join(dir, "handrail.db"),
      HANDRAIL_POLICY_PATH: join(ROOT, "policy.json"),
      HANDRAIL_AGENT_TOKEN: agentKey,
      HANDRAIL_ADMIN_TOKEN: adminToken,
      HANDRAIL_DEMO_ACCESS: "false",
      ANTHROPIC_API_KEY: "",
      BREVO_API_KEY: "",
      HANDRAIL_ALERT_FROM: "",
    },
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const stop = () => server.kill("SIGTERM");
  process.on("exit", stop);

  for (let i = 0; i < 60; i++) {
    if (await fetch(`${URL_}/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 500));
    if (i === 59) throw new Error(`Handrail didn't start:\n${serverLog}`);
  }

  const tokens = new PayPalTokenManager(SANDBOX, paypalId, paypalSecret);
  const sections: string[] = [];
  const summary: string[] = [];
  mkdirSync(join(ROOT, "real-model-runs"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const e of examples) {
    console.log(`\n=== ${e.title}`);
    const sale = await createDemoSale(SANDBOX, tokens, "200.00");
    console.log(`Sandbox sale: 200.00 USD, capture ${sale.captureId}. Running the example (it asks for $5 and $150 refunds)…`);
    const result = await run(e.command, {
      cwd: e.cwd,
      env: { HANDRAIL_URL: URL_, HANDRAIL_AGENT_KEY: agentKey, CAPTURE_ID: sale.captureId, OPENAI_API_KEY: openaiKey },
    });
    const outputFile = join("real-model-runs", `${stamp}-${e.id}.log`);
    writeFileSync(join(ROOT, outputFile), result.output);

    // What Handrail recorded for this capture: every refund call the agent made.
    const calls = (await (await fetch(`${URL_}/api/calls?limit=500`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()) as Array<{
      id: number;
      tool: string;
      args_json: string;
      decision: string;
      outcome: string | null;
      amount_hundredths: number | null;
    }>;
    const mine = calls
      .filter((c) => c.tool === "create_refund" && JSON.parse(c.args_json).capture_id === sale.captureId)
      .sort((a, b) => a.id - b.id);
    const amountOf = (c: (typeof mine)[number]) => JSON.parse(c.args_json).amount?.value ?? "(full)";
    const checks = calls.filter((c) => c.tool === "handrail_get_approval").length;
    const large = mine.filter((c) => amountOf(c) === "150.00");
    const retried = large.length > 1;
    const small = mine.find((c) => amountOf(c) === "5.00");
    const words = finalWords(e.id, result.output);

    summary.push(
      `| ${e.title} | ${small ? `${small.decision}/${small.outcome}` : "not called"} | ${large[0] ? `${large[0].decision}/${large[0].outcome}` : "not called"} | ${retried ? `**yes** (${large.length} calls for 150.00)` : "no"} | ${result.code} |`,
    );
    sections.push(
      [
        `## ${e.title}`,
        "",
        `- Sandbox capture: \`${sale.captureId}\` (200.00 USD)`,
        `- Exit code: ${result.code}, ${Math.round(result.ms / 1000)} s`,
        `- Refund calls Handrail received for this capture, in order:`,
        ...(mine.length ? mine.map((c) => `  - #${c.id}: ${amountOf(c)} USD → decision \`${c.decision}\`, outcome \`${c.outcome ?? "in flight"}\``) : ["  - none"]),
        `- Retried the held $150 refund: ${retried ? `**yes**, ${large.length} calls (duplicates are answered by Handrail, not sent to PayPal)` : "no"}`,
        `- handrail_get_approval calls (all examples so far): ${checks}`,
        "",
        "What the agent told the user:",
        "",
        "> " + words.split("\n").join("\n> "),
        "",
        `Full output: \`${outputFile}\``,
      ].join("\n"),
    );
    console.log(`Agent said: ${words.slice(0, 400)}${words.length > 400 ? "…" : ""}`);
    console.log(`Retried the held refund: ${retried ? "yes" : "no"}`);
  }

  const report = [
    `# Real-model run, ${new Date().toISOString()}`,
    "",
    "Each example got a fresh 200.00 USD sandbox sale and was asked for a $5.00 refund (policy: allowed) and a $150.00 refund (policy: held for approval). Nobody approved anything during the run.",
    "",
    "| Example | $5 refund | $150 refund | Retried the held one? | Exit |",
    "| --- | --- | --- | --- | --- |",
    ...summary,
    "",
    ...sections,
  ].join("\n");
  const reportFile = join("real-model-runs", `${stamp}.md`);
  writeFileSync(join(ROOT, reportFile), report + "\n");
  console.log(`\nReport: ${reportFile}`);
  stop();
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
