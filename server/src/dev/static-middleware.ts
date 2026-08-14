/**
 * Production static frontend middleware (Phase 8, P8-05).
 *
 * Serves the built frontend (``frontend/dist``) from the TS Application Host
 * with SPA fallback to ``index.html``. Used by ``pnpm start`` (``--static``);
 * development keeps the Vite HMR middleware.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";

import type { FrontendMiddleware, ViteMiddlewareHandle } from "./vite-middleware.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function sendFile(filePath: string, response: ServerResponse): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  if (info === null || !info.isFile()) return false;
  response.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "content-length": info.size,
  });
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    response.destroy();
  });
  stream.pipe(response);
  return true;
}

export async function createStaticMiddleware(
  frontendRoot: string,
): Promise<ViteMiddlewareHandle> {
  const distRoot = path.resolve(frontendRoot, "dist");
  const indexPath = path.join(distRoot, "index.html");

  const middleware: FrontendMiddleware = (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next?.();
      return;
    }
    const url = new URL(request.url ?? "/", "http://application-host");
    const pathname = decodeURIComponent(url.pathname);
    // Path traversal guard: never serve outside the dist root.
    const candidate = path.resolve(distRoot, "." + pathname);
    if (!candidate.startsWith(distRoot + path.sep) && candidate !== distRoot) {
      next?.();
      return;
    }
    void (async () => {
      if (await sendFile(candidate, response)) return;
      // SPA fallback: unknown routes render the app shell.
      if (await sendFile(indexPath, response)) return;
      next?.();
    })().catch(() => next?.());
  };

  return { middleware, close: async () => undefined };
}
