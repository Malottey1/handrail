// Approve or reject held calls from the terminal, through the admin API of a
// running Handrail.
//
//   npm run approvals                          list pending approvals
//   npm run approvals -- approve <id> [note]
//   npm run approvals -- reject <id> [note]
import "dotenv/config";
import { userInfo } from "node:os";

const token = process.env.HANDRAIL_ADMIN_TOKEN?.trim();
const base = `http://127.0.0.1:${Number(process.env.PORT) || 8787}/api`;

if (!token) {
  console.error("Set HANDRAIL_ADMIN_TOKEN in .env (and restart Handrail) to use the admin API.");
  process.exit(1);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    console.error(`Can't reach Handrail at ${base}. Is it running?`);
    process.exit(1);
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${data.error ?? JSON.stringify(data)}`);
    process.exit(1);
  }
  return data;
}

const [command, id, ...noteWords] = process.argv.slice(2);
const note = noteWords.join(" ") || undefined;

if (!command) {
  const pending = await api("GET", "/approvals?status=pending");
  if (pending.length === 0) console.log("No pending approvals.");
  for (const a of pending) {
    const amount = a.amount ? `${(a.amount.hundredths / 100).toFixed(2)} ${a.amount.currency}` : "amount unknown";
    console.log(`${a.id}  ${a.tool}  ${amount}\n  why held: ${a.reason}\n  args: ${JSON.stringify(a.args)}\n  expires: ${a.expiresAt}\n`);
  }
} else if ((command === "approve" || command === "reject") && id) {
  const a = await api("POST", `/approvals/${id}/${command}`, { by: userInfo().username, note });
  console.log(`${a.id} is now ${a.status}`);
  if (a.result) console.log(JSON.stringify(a.result, null, 2).slice(0, 2000));
} else {
  console.error("Usage: npm run approvals [-- approve|reject <id> [note]]");
  process.exit(1);
}
