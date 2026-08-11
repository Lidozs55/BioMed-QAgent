import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { createApplicationHost, type ApplicationHost } from "../src/app/create-app.js";
import { LifecycleRegistry } from "../src/app/lifecycle.js";

const hosts: ApplicationHost[] = [];
const legacyServers: Server[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    legacyServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

function requestUrl(host: ApplicationHost, path: string): string {
  const address = host.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}${path}`;
}

describe("application host", () => {
  test("preserves legacy HTTP method, path, query, body, status, and headers", async () => {
    const legacy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.writeHead(207, { "x-legacy-response": "kept", "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
          header: request.headers["x-legacy-request"],
        }),
      );
    });
    legacyServers.push(legacy);
    const legacyPort = await listen(legacy);
    const host = await createApplicationHost({
      publicHost: "0.0.0.0",
      publicPort: 0,
      legacy: async () => ({ target: `http://127.0.0.1:${legacyPort}`, close: async () => undefined }),
      frontend: async () => ({ middleware: (_request, response) => response.end("frontend"), close: async () => undefined }),
    });
    hosts.push(host);

    const response = await fetch(requestUrl(host, "/api/v1/echo?x=1"), {
      method: "POST",
      headers: { "x-legacy-request": "kept", "content-type": "text/plain" },
      body: "payload",
    });

    expect(response.status).toBe(207);
    expect(response.headers.get("x-legacy-response")).toBe("kept");
    expect(await response.json()).toEqual({
      method: "POST",
      url: "/api/v1/echo?x=1",
      body: "payload",
      header: "kept",
    });
    expect(host.server.address()).toMatchObject({ address: "0.0.0.0" });
    expect(legacy.address()).toMatchObject({ address: "127.0.0.1" });
  });

  test("forwards only the legacy WebSocket upgrade path", async () => {
    const legacy = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    legacy.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (websocket) => websocket.on("message", (message) => websocket.send(message)));
    legacyServers.push(legacy);
    const legacyPort = await listen(legacy);
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      legacy: async () => ({ target: `http://127.0.0.1:${legacyPort}`, close: async () => undefined }),
      frontend: async () => ({ middleware: (_request, response) => response.end("frontend"), close: async () => undefined }),
    });
    hosts.push(host);
    const hostPort = (host.server.address() as AddressInfo).port;
    const websocket = new WebSocket(`ws://127.0.0.1:${hostPort}/api/v1/ws`);
    await once(websocket, "open");
    websocket.send("ping");
    const [message] = await once(websocket, "message");
    websocket.close();

    expect(message.toString()).toBe("ping");
  });

  test("rejects internal migration paths without touching proxy and delegates frontend fallback", async () => {
    let legacyHits = 0;
    const legacy = createServer((_request, response) => {
      legacyHits += 1;
      response.end("legacy");
    });
    legacyServers.push(legacy);
    const legacyPort = await listen(legacy);
    const frontend = vi.fn((_request, response) => response.end("from-vite"));
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      legacy: async () => ({ target: `http://127.0.0.1:${legacyPort}`, close: async () => undefined }),
      frontend: async () => ({ middleware: frontend, close: async () => undefined }),
    });
    hosts.push(host);

    const internal = await fetch(requestUrl(host, "/internal/migration/build"));
    const fallback = await fetch(requestUrl(host, "/some/frontend/route"));

    expect(internal.status).toBe(404);
    expect(legacyHits).toBe(0);
    expect(await fallback.text()).toBe("from-vite");
    expect(frontend).toHaveBeenCalledOnce();
  });

  test("readiness failure prevents public listen and closes earlier resources", async () => {
    const earlier = vi.fn(async () => undefined);
    const registry = new LifecycleRegistry();
    registry.add("later Pi lifecycle hook", earlier);
    const listenPublic = vi.fn(async () => undefined);

    await expect(
      createApplicationHost(
        {
          publicHost: "127.0.0.1",
          publicPort: 0,
          legacy: async () => {
            throw new Error("legacy readiness failed");
          },
          frontend: async () => ({ middleware: (_request, response) => response.end(), close: async () => undefined }),
          lifecycle: registry,
        },
        { listenPublic },
      ),
    ).rejects.toThrow("legacy readiness failed");

    expect(listenPublic).not.toHaveBeenCalled();
    expect(earlier).toHaveBeenCalledOnce();
  });
});
