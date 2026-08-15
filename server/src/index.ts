import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationHost } from "./app/create-app.js";
import { createBootstrapOptions } from "./bootstrap.js";
import { parseHostConfig, resolveOutputDir } from "./config.js";
import { createViteMiddleware } from "./dev/vite-middleware.js";
import { createStaticMiddleware } from "./dev/static-middleware.js";

async function main(): Promise<void> {
  const config = parseHostConfig(process.env);
  const serveStatic = process.argv.includes("--static");
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tasksRoot = path.join(
    resolveOutputDir(repositoryRoot, process.env.OUTPUT_DIR),
    "tasks",
  );
  const bootstrap = await createBootstrapOptions({
    config,
    repositoryRoot,
    tasksRoot,
  });
  const host = await createApplicationHost({
    ...bootstrap,
    frontend: (httpServer) =>
      serveStatic
        ? createStaticMiddleware(path.join(repositoryRoot, "frontend"))
        : createViteMiddleware({
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
