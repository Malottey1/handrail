import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/**
 * Serves the built dashboard (web/dist). Unknown paths get index.html so the
 * app can handle them. Returns false if there is no build, or for non-GETs.
 * The dashboard itself is public; everything it shows comes from /api, which
 * needs the admin token.
 */
export async function serveDashboard(req: IncomingMessage, res: ServerResponse, root: string): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const base = resolve(root);
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return false; // malformed %-escape
  }
  let file = resolve(base, "." + normalize(path));
  if (file !== base && !file.startsWith(base + sep)) return false; // path traversal

  const isFile = async (p: string) => (await stat(p).catch(() => null))?.isFile() ?? false;
  if (!(await isFile(file))) {
    if (extname(path)) return false; // a missing asset is a 404, not the app
    file = join(base, "index.html");
    if (!(await isFile(file))) return false;
  }

  const body = await readFile(file);
  const immutable = file.includes(`${sep}assets${sep}`); // Vite fingerprints these
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
