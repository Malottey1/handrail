import { redact } from "./redact.js";

// All logs go to stderr: in stdio mode, stdout carries the MCP protocol.
// Every message is redacted (src/redact.ts), so a secret in an error can't reach the logs.
export function log(...args: unknown[]): void {
  console.error(`[handrail ${new Date().toISOString()}]`, ...args.map((a) => redact(a instanceof Error ? a.message : String(a))));
}
