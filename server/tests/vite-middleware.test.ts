import { createServer } from "node:http";

import { expect, test, vi } from "vitest";

import {
  createViteMiddleware,
  type FrontendMiddleware,
} from "../src/dev/vite-middleware.js";

test("configures Vite middleware and HMR on the Host HTTP server", async () => {
  const httpServer = createServer();
  const close = vi.fn(async () => undefined);
  const middleware: FrontendMiddleware = vi.fn();
  const createViteServer = vi.fn(async () => ({ middlewares: middleware, close }));

  const handle = await createViteMiddleware(
    { frontendRoot: "/repo/frontend", httpServer },
    { createViteServer },
  );

  expect(createViteServer).toHaveBeenCalledWith(
    expect.objectContaining({
      root: "/repo/frontend",
      appType: "spa",
      server: expect.objectContaining({
        middlewareMode: true,
        hmr: { server: httpServer },
      }),
    }),
  );
  expect(handle.middleware).toBe(middleware);
  await handle.close();
  expect(close).toHaveBeenCalledOnce();
});
