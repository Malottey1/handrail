// All logs go to stderr: in stdio mode, stdout carries the MCP protocol.
export function log(...args: unknown[]): void {
  console.error(`[handrail ${new Date().toISOString()}]`, ...args);
}
