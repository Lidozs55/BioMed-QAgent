/**
 * Phase 5 test helpers: local fixture HTTP server + executor that routes
 * policy-pinned requests to it, and a fake DNS resolver mapping hostnames to
 * configured (public or private) addresses.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressResolver, ResolvedAddress } from "../../src/external/network/dns.js";
import type { RequestExecutor } from "../../src/external/network/http-client.js";

export const PUBLIC_IP = { address: "93.184.216.34", family: 4 as const };
export const SECOND_PUBLIC_IP = { address: "8.8.8.8", family: 4 as const };

export function fakeResolver(
  records: Record<string, ResolvedAddress[]>,
): AddressResolver {
  return async (hostname) => {
    const normalized = hostname.replace(/^\[|\]$/g, "");
    const addresses = records[normalized];
    if (addresses === undefined) {
      throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    }
    return addresses;
  };
}

export interface FixtureRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface FixtureServer {
  server: Server;
  port: number;
  requests: FixtureRequest[];
  close(): Promise<void>;
}

export type FixtureHandler = (req: IncomingMessage, res: ServerResponse, requests: FixtureRequest[]) => void | Promise<void>;

export async function startFixtureServer(handler: FixtureHandler): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", headers, body: Buffer.concat(chunks).toString("utf8") });
      void Promise.resolve(handler(req, res, requests)).catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(`fixture handler error: ${String(error)}`);
        } else {
          res.destroy();
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server failed to bind");
  return {
    server,
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Executor that ignores the pinned target and speaks to the local fixture server. */
export function localExecutor(port: number): RequestExecutor {
  return (request) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `${request.url.pathname}${request.url.search}`,
          method: request.method,
          headers: request.headers,
        },
        (res) => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
          }
          const body = (async function* iterate(): AsyncIterable<Buffer> {
            for await (const chunk of res) yield chunk as Buffer;
          })();
          resolve({ status: res.statusCode ?? 0, headers, body });
        },
      );
      req.on("error", reject);
      if (request.signal !== undefined) {
        const abort = (): void => {
          req.destroy(request.signal?.reason instanceof Error ? request.signal.reason : new Error("aborted"));
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      }
      if (request.body !== null) {
        req.write(request.body);
      }
      req.end();
    });
}
