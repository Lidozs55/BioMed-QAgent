import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { createApplicationHost, type ApplicationHost } from "../src/app/create-app.js";
import { LifecycleRegistry } from "../src/app/lifecycle.js";

const hosts: ApplicationHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

function requestUrl(host: ApplicationHost, path: string): string {
  const address = host.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}${path}`;
}

describe("application host (Phase 8: no legacy proxy, no experimental Pi)", () => {
  test("starts without any legacy backend and fails closed for unhandled formal routes", async () => {
    const formalRuntime = vi.fn(async () => ({
      handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
        if (request.url !== "/api/v1/tasks") return false;
        response.end("native tasks");
        return true;
      },
      handleUpgrade: () => false,
      close: async () => undefined,
    }));
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      formalRuntime,
      frontend: async () => ({
        middleware: (_request, response) => response.end("frontend"),
        close: async () => undefined,
      }),
    });
    hosts.push(host);

    expect(formalRuntime).toHaveBeenCalledWith();
    expect(await (await fetch(requestUrl(host, "/api/v1/tasks"))).text()).toBe("native tasks");
    const missing = await fetch(requestUrl(host, "/api/v1/not-migrated"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not Found");
  });

  test("delegates non-API paths to the frontend middleware", async () => {
    const frontend = vi.fn((_request, response) => response.end("from-vite"));
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      frontend: async () => ({ middleware: frontend, close: async () => undefined }),
    });
    hosts.push(host);

    const fallback = await fetch(requestUrl(host, "/some/frontend/route"));
    expect(await fallback.text()).toBe("from-vite");
    expect(frontend).toHaveBeenCalledOnce();
    // legacy migration paths are no longer special — they are frontend routes
    const internal = await fetch(requestUrl(host, "/internal/migration/build"));
    expect(internal.status).toBe(200);
    expect(await internal.text()).toBe("from-vite");
  });

  test("gives Host-owned API surfaces precedence over the formal runtime", async () => {
    const hostApi = {
      handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
        if (request.url !== "/api/v1/settings") return false;
        response.end("host settings");
        return true;
      },
    };
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      hostApi,
      formalRuntime: async () => ({
        handle: (_request, response) => { response.end("formal"); return true; },
        handleUpgrade: () => false,
        close: async () => undefined,
      }),
      frontend: async () => ({ middleware: (_request, response) => response.end(), close: async () => undefined }),
    });
    hosts.push(host);

    expect(await (await fetch(requestUrl(host, "/api/v1/settings"))).text()).toBe("host settings");
  });

  test("lets the formal TS runtime own the WebSocket upgrade path", async () => {
    const formalSocket = vi.fn();
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      formalRuntime: async () => {
        const websocketServer = new WebSocketServer({ noServer: true });
        websocketServer.on("connection", (websocket) => websocket.on("message", (message) => {
          formalSocket(message.toString());
          websocket.send("formal websocket");
        }));
        return {
          handle: () => false,
          handleUpgrade(request, socket, head) {
            if (request.url !== "/api/v1/ws") return false;
            websocketServer.handleUpgrade(request, socket, head, (websocket) => {
              websocketServer.emit("connection", websocket, request);
            });
            return true;
          },
          close: async () => websocketServer.close(),
        };
      },
      frontend: async () => ({
        middleware: (_request, response) => response.end("frontend"),
        close: async () => undefined,
      }),
    });
    hosts.push(host);

    const port = (host.server.address() as AddressInfo).port;
    const websocket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    await once(websocket, "open");
    websocket.send("ping");
    const [message] = await once(websocket, "message");
    expect(message.toString()).toBe("formal websocket");
    expect(formalSocket).toHaveBeenCalledWith("ping");
    websocket.close();
  });

  test("destroys non-API WebSocket upgrades", async () => {
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      frontend: async () => ({
        middleware: (_request, response) => response.end("frontend"),
        close: async () => undefined,
      }),
    });
    hosts.push(host);

    const port = (host.server.address() as AddressInfo).port;
    await expect(new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/experimental/pi/ws`);
      socket.once("open", () => reject(new Error("experimental upgrade must not open")));
      socket.once("unexpected-response", () => resolve());
      socket.once("error", () => resolve());
    })).resolves.toBeUndefined();
  });

  test("startup failure prevents public listen and closes earlier resources", async () => {
    const earlier = vi.fn(async () => undefined);
    const registry = new LifecycleRegistry();
    registry.add("later Pi lifecycle hook", earlier);
    const listenPublic = vi.fn(async () => undefined);

    await expect(
      createApplicationHost(
        {
          publicHost: "127.0.0.1",
          publicPort: 0,
          formalRuntime: async () => {
            throw new Error("formal runtime failed");
          },
          frontend: async () => ({ middleware: (_request, response) => response.end(), close: async () => undefined }),
          lifecycle: registry,
        },
        { listenPublic },
      ),
    ).rejects.toThrow("formal runtime failed");

    expect(listenPublic).not.toHaveBeenCalled();
    expect(earlier).toHaveBeenCalledOnce();
  });
});
