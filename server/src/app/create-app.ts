
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type { FrontendMiddleware, ViteMiddlewareHandle } from "../dev/vite-middleware.js";
import { LifecycleRegistry } from "./lifecycle.js";

/** 应用 WebSocket 路径；其他 upgrade（如 Vite HMR）由同一 server 的监听器接管。 */
export const WS_UPGRADE_PATH = "/api/v1/ws";

export interface ApplicationHostOptions {
  publicHost: string;
  publicPort: number;
  frontend: (server: Server) => Promise<ViteMiddlewareHandle>;
  lifecycle?: LifecycleRegistry;
  initializeLifecycle?: (lifecycle: LifecycleRegistry) => void | Promise<void>;
  /** 端口绑定成功即回调（此时初始化尚未完成），用于打印 starting banner。 */
  onListening?: (address: AddressInfo) => void;
  hostApi?: {
    handle: (request: IncomingMessage, response: ServerResponse) => boolean;
  };
  formalRuntime?: () => Promise<{
    handle: (request: IncomingMessage, response: ServerResponse) => boolean;
    handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
    close: () => Promise<void>;
  }>;
}

export interface ApplicationHostDependencies {
  createHttpServer?: (
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ) => Server;
  listenPublic?: (server: Server, port: number, host: string) => Promise<void>;
}

export interface ApplicationHost {
  server: Server;
  close: () => Promise<void>;
}

function pathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://application-host").pathname;
}

function isFormalApi(requestPath: string): boolean {
  return requestPath === "/api/v1" || requestPath.startsWith("/api/v1/");
}

function routeRequest(
  frontend: FrontendMiddleware,
  hostApi?: {
    handle: (request: IncomingMessage, response: ServerResponse) => boolean;
  },
  formalRuntime?: {
    handle: (request: IncomingMessage, response: ServerResponse) => boolean;
  },
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const requestPath = pathname(request);
    if (hostApi?.handle(request, response) === true) return;
    if (isFormalApi(requestPath)) {
      if (formalRuntime?.handle(request, response) === true) return;
      response.writeHead(404);
      response.end("Not Found");
      return;
    }
    frontend(request, response, (error) => {
      if (error !== undefined) {
        response.writeHead(500);
        response.end("Frontend middleware failed");
        return;
      }
      response.writeHead(404);
      response.end("Not Found");
    });
  };
}

function listenPublic(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

async function listenWithSystemFallback(
  listen: (server: Server, port: number, host: string) => Promise<void>,
  server: Server,
  preferredPort: number,
  host: string,
): Promise<void> {
  try {
    await listen(server, preferredPort, host);
  } catch (error) {
    if (preferredPort === 0 || !isAddressInUse(error)) throw error;
    await listen(server, 0, host);
  }
}

function closePublicServer(server: Server, upgradedSockets: Set<Duplex>): Promise<void> {
  for (const socket of upgradedSockets) socket.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export async function createApplicationHost(
  options: ApplicationHostOptions,
  dependencies: ApplicationHostDependencies = {},
): Promise<ApplicationHost> {
  const lifecycle = options.lifecycle ?? new LifecycleRegistry({ timeoutMs: 15_000 });
  const upgradedSockets = new Set<Duplex>();
  // 初始化完成前的请求一律 503；初始化完成后切换到正式路由。
  let requestHandler = (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "starting" }));
  };
  const serverFactory = dependencies.createHttpServer ?? createServer;
  const server = serverFactory((request, response) => requestHandler(request, response));
  // formal runtime 在初始化阶段创建，upgrade 处理器通过可变引用延迟绑定。
  let formalRuntime:
    | {
        handle: (request: IncomingMessage, response: ServerResponse) => boolean;
        handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
        close: () => Promise<void>;
      }
    | undefined;

  // upgrade 所有权在 server 创建后立即固定：只接管 /api/v1/ws。
  // 其他 upgrade（Vite HMR 等）必须放行，不能 socket.destroy()——
  // 否则 Vite HMR WebSocket 每次连接都被杀掉，页面陷入无限刷新。
  server.on("upgrade", (request, socket, head) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    if (pathname(request) === WS_UPGRADE_PATH) {
      // runtime 尚未就绪（初始化阶段）时没有处理者，销毁让客户端重试。
      if (formalRuntime?.handleUpgrade(request, socket, head) !== true) {
        socket.destroy();
      }
      return;
    }
    // 其他路径不处理：Vite 从同一个 server 接管 HMR WebSocket。
    // 兜底：若没有任何监听器接管（例如非法 upgrade），客户端关闭时会触发
    // socket error——必须挂监听避免 unhandled 'error' 崩溃整个进程。
    // 连接生命周期由 upgradedSockets 统一管理（close 时销毁）。
    socket.on("error", () => undefined);
  });

  try {
    // 端口立即打开：初始化期间请求拿到 503 starting，而不是“程序像死了一样”。
    await listenWithSystemFallback(
      dependencies.listenPublic ?? listenPublic,
      server,
      options.publicPort,
      options.publicHost,
    );
    lifecycle.add("public HTTP server", () => closePublicServer(server, upgradedSockets));
    options.onListening?.(server.address() as AddressInfo);

    await options.initializeLifecycle?.(lifecycle);

    formalRuntime = await options.formalRuntime?.();
    if (formalRuntime !== undefined) {
      lifecycle.add("formal TypeScript runtime", formalRuntime.close);
    }

    const frontend = await options.frontend(server);
    lifecycle.add("Vite middleware", frontend.close);
    requestHandler = routeRequest(frontend.middleware, options.hostApi, formalRuntime);

    return { server, close: () => lifecycle.close() };
  } catch (startupError) {
    try {
      await lifecycle.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Application Host startup and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw startupError;
  }
}
