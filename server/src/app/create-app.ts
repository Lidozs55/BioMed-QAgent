import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { FrontendMiddleware, ViteMiddlewareHandle } from "../dev/vite-middleware.js";
import { LifecycleRegistry } from "./lifecycle.js";

export interface ApplicationHostOptions {
  publicHost: string;
  publicPort: number;
  frontend: (server: Server) => Promise<ViteMiddlewareHandle>;
  lifecycle?: LifecycleRegistry;
  initializeLifecycle?: (lifecycle: LifecycleRegistry) => void | Promise<void>;
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
  let requestHandler = (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(503);
    response.end("Application Host is starting");
  };
  const serverFactory = dependencies.createHttpServer ?? createServer;
  const server = serverFactory((request, response) => requestHandler(request, response));

  try {
    await options.initializeLifecycle?.(lifecycle);

    const formalRuntime = await options.formalRuntime?.();
    if (formalRuntime !== undefined) {
      lifecycle.add("formal TypeScript runtime", formalRuntime.close);
    }

    const frontend = await options.frontend(server);
    lifecycle.add("Vite middleware", frontend.close);
    requestHandler = routeRequest(frontend.middleware, options.hostApi, formalRuntime);

    server.on("upgrade", (request, socket, head) => {
      upgradedSockets.add(socket);
      socket.once("close", () => upgradedSockets.delete(socket));
      const requestPath = pathname(request);
      if (requestPath === "/api/v1/ws") {
        if (formalRuntime?.handleUpgrade(request, socket, head) !== true) {
          socket.destroy();
        }
      } else {
        socket.destroy();
      }
    });

    await (dependencies.listenPublic ?? listenPublic)(
      server,
      options.publicPort,
      options.publicHost,
    );
    lifecycle.add("public HTTP server", () => closePublicServer(server, upgradedSockets));
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
