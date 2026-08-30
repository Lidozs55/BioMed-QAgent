import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { createApplicationHost, type ApplicationHost } from "../src/app/create-app.js";
import { LifecycleRegistry } from "../src/app/lifecycle.js";

const hosts: ApplicationHost[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function occupyEphemeralPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, server };
}

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

  test("leaves non-API WebSocket upgrades to other owners (Vite HMR)", async () => {
    // 回归：Host 曾对非 /api/v1/ws 的 upgrade 一律 socket.destroy()，
    // 导致 Vite HMR WebSocket 每次连接都被杀 → 页面无限刷新。
    const formalUpgrade = vi.fn();
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      formalRuntime: async () => ({
        handle: () => false,
        handleUpgrade: (request, socket) => {
          formalUpgrade(request.url);
          if (request.url !== "/api/v1/ws") return false;
          socket.destroy();
          return true;
        },
        close: async () => undefined,
      }),
      frontend: async () => ({
        middleware: (_request, response) => response.end("frontend"),
        close: async () => undefined,
      }),
    });
    hosts.push(host);

    // 非应用路径（Vite HMR 的 /__vite_hmr、任意其他 upgrade）：
    // 不交给 formal runtime，也不销毁——由同一 server 的其他监听器接管。
    const hmrSocket = { once: vi.fn(), destroy: vi.fn(), on: vi.fn() };
    host.server.emit("upgrade", { url: "/__vite_hmr", headers: {} }, hmrSocket, Buffer.alloc(0));
    expect(hmrSocket.destroy).not.toHaveBeenCalled();
    expect(formalUpgrade).not.toHaveBeenCalled();
    // 兜底：无人接管时挂 error 监听，防止客户端断开触发 unhandled error 崩溃。
    expect(hmrSocket.on).toHaveBeenCalledWith("error", expect.any(Function));

    const otherSocket = { once: vi.fn(), destroy: vi.fn(), on: vi.fn() };
    host.server.emit("upgrade", { url: "/custom/ws", headers: {} }, otherSocket, Buffer.alloc(0));
    expect(otherSocket.destroy).not.toHaveBeenCalled();

    // 应用路径仍由 formal runtime 接管。
    const appSocket = { once: vi.fn(), destroy: vi.fn(), on: vi.fn() };
    host.server.emit("upgrade", { url: "/api/v1/ws", headers: {} }, appSocket, Buffer.alloc(0));
    expect(formalUpgrade).toHaveBeenCalledWith("/api/v1/ws");
    expect(appSocket.destroy).toHaveBeenCalledTimes(1); // runtime 返回 true，由其自行关闭
  });

  test("destroys /api/v1/ws upgrades before the runtime is initialized", async () => {
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      frontend: async () => ({
        middleware: (_request, response) => response.end("frontend"),
        close: async () => undefined,
      }),
    });
    hosts.push(host);

    // 初始化阶段（formal runtime 尚未就绪）的应用 WS 升级只能销毁，客户端重试。
    const socket = { once: vi.fn(), destroy: vi.fn() };
    host.server.emit("upgrade", { url: "/api/v1/ws", headers: {} }, socket, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  test("listens before initialization; requests get 503 starting until ready", async () => {
    let resolveRuntime: () => void = () => undefined;
    const runtimeGate = new Promise<void>((resolve) => { resolveRuntime = resolve; });
    let resolveListening: (port: number) => void = () => undefined;
    const listening = new Promise<number>((resolve) => { resolveListening = resolve; });
    const listenPublic = async (server: import("node:http").Server): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          resolveListening((server.address() as AddressInfo).port);
          resolve();
        });
      });
    };
    let host: ApplicationHost | undefined;
    const creating = createApplicationHost(
      {
        publicHost: "127.0.0.1",
        publicPort: 0,
        formalRuntime: async () => {
          await runtimeGate;
          return {
            handle: (request, response) => {
              if (request.url !== "/api/v1/tasks") return false;
              response.end("native tasks");
              return true;
            },
            handleUpgrade: () => false,
            close: async () => undefined,
          };
        },
        frontend: async () => ({
          middleware: (_request, response) => response.end("frontend"),
          close: async () => undefined,
        }),
      },
      { listenPublic },
    ).then((created) => { host = created; });

    // 初始化期间端口已可用：返回 503 {"status":"starting"}。
    const actualPort = await listening;
    expect(host).toBeUndefined();
    const starting = await fetch(`http://127.0.0.1:${actualPort}/`);
    expect(starting.status).toBe(503);
    expect(await starting.json()).toEqual({ status: "starting" });

    resolveRuntime();
    await creating;
    const ready = await fetch(`http://127.0.0.1:${actualPort}/api/v1/tasks`);
    expect(await ready.text()).toBe("native tasks");
  });

  test("falls back to an OS-assigned port when the preferred port is occupied", async () => {
    const occupied = await occupyEphemeralPort();
    const onListening = vi.fn();
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: occupied.port,
      onListening,
      frontend: async () => ({
        middleware: (_request, response) => response.end("frontend"),
        close: async () => undefined,
      }),
    });
    hosts.push(host);

    const actualPort = (host.server.address() as AddressInfo).port;
    expect(actualPort).not.toBe(occupied.port);
    expect(actualPort).toBeGreaterThan(0);
    expect(onListening).toHaveBeenCalledOnce();
    expect(onListening).toHaveBeenCalledWith(expect.objectContaining({ port: actualPort }));
    expect(await (await fetch(requestUrl(host, "/"))).text()).toBe("frontend");
  });

  test("does not retry non-address-conflict listen errors or initialize resources", async () => {
    const listenError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const listenPublic = vi.fn(async () => { throw listenError; });
    const initializeLifecycle = vi.fn();
    const formalRuntime = vi.fn();
    const frontend = vi.fn(async () => ({
      middleware: (_request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => response.end(),
      close: async () => undefined,
    }));

    await expect(createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 5173,
      initializeLifecycle,
      formalRuntime,
      frontend,
    }, { listenPublic })).rejects.toBe(listenError);

    expect(listenPublic).toHaveBeenCalledOnce();
    expect(initializeLifecycle).not.toHaveBeenCalled();
    expect(formalRuntime).not.toHaveBeenCalled();
    expect(frontend).not.toHaveBeenCalled();
  });

  test("closes the fallback port when initialization fails", async () => {
    const occupied = await occupyEphemeralPort();
    let fallbackPort = 0;

    await expect(createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: occupied.port,
      onListening: (address) => { fallbackPort = address.port; },
      initializeLifecycle: async () => { throw new Error("bootstrap failed"); },
      frontend: async () => ({
        middleware: (_request, response) => response.end(),
        close: async () => undefined,
      }),
    })).rejects.toThrow("bootstrap failed");

    expect(fallbackPort).toBeGreaterThan(0);
    const rebound = createServer();
    servers.push(rebound);
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen(fallbackPort, "127.0.0.1", resolve);
    });
  });

  test("startup failure after listen closes earlier resources", async () => {
    const earlier = vi.fn(async () => undefined);
    const registry = new LifecycleRegistry();
    registry.add("later Pi lifecycle hook", earlier);
    // 真实 listen（port 0）：新语义下端口先于初始化绑定，失败后 close 需要
    // server 处于已运行状态才能正常关闭。
    const listenPublic = vi.fn(async (server: import("node:http").Server) => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    });

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

    // 新语义：端口先于初始化绑定；失败时 lifecycle 仍关闭已注册资源。
    expect(listenPublic).toHaveBeenCalledOnce();
    expect(earlier).toHaveBeenCalledOnce();
  });
});
