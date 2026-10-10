// Checks the tamper-evident audit log in handrail.db.
//
//   npm run audit:verify
//
// Recomputes every entry's hash and checks that tool_calls, approvals and
// webhook_events still agree with the log. Exits 1 if anything was altered.
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { AuditChain } from "../src/audit-chain.js";

const path = process.env.HANDRAIL_DB_PATH?.trim() || "handrail.db";
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000;");
const result = new AuditChain(db).verify();

console.log(`${path}: ${result.entries} audit entries`);
console.log(`head ${result.head}`);
if (result.ok) {
  console.log("OK: every hash checks out and the working tables match the log.");
} else {
  console.log(`TAMPERING DETECTED: ${result.problems.length} problem(s)`);
  for (const p of result.problems) console.log(`  ${p.seq ? `#${p.seq} ` : ""}${p.ref ?? ""}: ${p.problem}`);
  process.exitCode = 1;
}
