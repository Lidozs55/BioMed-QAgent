/**
 * Request-body reading for the application host's native API surface.
 * Unifies the 1 MiB limit + JSON parse behavior that used to be duplicated
 * in ``product-api.ts`` and ``model-settings.ts``.
 */
import type { IncomingMessage } from "node:http";

import { HttpError } from "./error.js";

export interface ApiSurface {
  handle(request: IncomingMessage, response: import("node:http").ServerResponse): boolean;
}

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * Stream the request body (bounded by *maxBytes*) and JSON.parse it.
 * Throws ``HttpError(413)`` when oversized and ``HttpError(400)`` when the
 * payload is not valid JSON. Returns the raw parsed value — callers narrow it
 * with ``asRecord``/``optionalRecord`` from ``./validation.js``.
 */
export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}