import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";

import { createServer, type InlineConfig } from "vite";

export type FrontendMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next?: (error?: unknown) => void,
) => void;

export interface ViteMiddlewareHandle {
  middleware: FrontendMiddleware;
  close: () => Promise<void>;
}

export interface ViteMiddlewareOptions {
  frontendRoot: string;
  httpServer: Server;
}

export interface ViteMiddlewareDependencies {
  createViteServer: (config: InlineConfig) => Promise<{
    middlewares: FrontendMiddleware;
    close: () => Promise<void>;
  }>;
}

export async function createViteMiddleware(
  options: ViteMiddlewareOptions,
  dependencies: ViteMiddlewareDependencies = { createViteServer: createServer },
): Promise<ViteMiddlewareHandle> {
  const vite = await dependencies.createViteServer({
    root: options.frontendRoot,
    configFile: path.join(options.frontendRoot, "vite.config.ts"),
    appType: "spa",
    server: {
      middlewareMode: true,
      hmr: { server: options.httpServer },
    },
  });
  return {
    middleware: vite.middlewares,
    close: () => vite.close(),
  };
}
