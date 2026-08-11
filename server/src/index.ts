import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationHost } from "./app/create-app.js";
import { LifecycleRegistry } from "./app/lifecycle.js";
import { parseHostConfig } from "./config.js";
import { createViteMiddleware } from "./dev/vite-middleware.js";
import { createLegacyBackend } from "./legacy/backend-process.js";

async function main(): Promise<void> {
  const config = parseHostConfig(process.env);
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const lifecycle = new LifecycleRegistry({ timeoutMs: config.shutdownTimeoutMs });
  const host = await createApplicationHost({
    publicHost: config.publicHost,
    publicPort: config.publicPort,
    lifecycle,
    legacy: () =>
      createLegacyBackend({
        repositoryRoot,
        privatePort: config.legacyPrivatePort,
        legacyUrl: config.legacyUrl,
        readinessTimeoutMs: config.legacyReadinessTimeoutMs,
        shutdownTimeoutMs: config.shutdownTimeoutMs,
      }),
    // Later Pi integration registers session cleanup through this lifecycle seam.
    initializeLifecycle: async () => undefined,
    frontend: (httpServer) =>
      createViteMiddleware({
        frontendRoot: path.join(repositoryRoot, "frontend"),
        httpServer,
      }),
  });

  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    shutdown ??= host.close();
    return shutdown;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().catch((error: unknown) => {
        console.error("Application Host shutdown failed", error);
        process.exitCode = 1;
      });
    });
  }

  const address = host.server.address();
  console.log("BioMed-QAgent Application Host listening", address);
}

main().catch((error: unknown) => {
  console.error("Application Host failed to start", error);
  process.exitCode = 1;
});
