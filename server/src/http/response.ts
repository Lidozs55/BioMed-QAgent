/**
 * JSON response helpers for the application host's native API surface.
 * Unifies the ``json()``/``error()`` helpers that used to be duplicated in
 * ``product-api.ts`` and ``model-settings.ts`` (including the 1 MiB body
 * handling, which now lives in ``./body.ts``).
 */
import type { ServerResponse } from "node:http";

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    ...extraHeaders,
  });
  response.end(bytes);
}

export function sendError(
  response: ServerResponse,
  status: number,
  detail: string,
): void {
  sendJson(response, status, { detail });
}

export function sendNoContent(response: ServerResponse): void {
  response.writeHead(204).end();
}