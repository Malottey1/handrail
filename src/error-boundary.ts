import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { log } from "./log.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Wraps the HTTP handler: an unexpected error gets a generic 500 with an id.
 * The (redacted) detail goes to the server log, never to the client (no
 * message, no stack trace), and it can't crash the server.
 */
export function withErrorBoundary(handle: Handler): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      const errorId = randomBytes(6).toString("hex");
      log(`Request error ${errorId} on ${req.method} ${req.url?.split("?")[0]}:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `Internal error (${errorId})`, errorId }));
      } else res.destroy();
    });
  };
}
