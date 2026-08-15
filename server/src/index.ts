import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createApplicationHost } from "./app/create-app.js";
import { createBootstrapOptions, type BootstrapOptions } from "./bootstrap.js";
import { parseHostConfig, resolveOutputDir } from "./config.js";
import { createViteMiddleware } from "./dev/vite-middleware.js";
import { createStaticMiddleware } from "./dev/static-middleware.js";

function bannerHost(publicHost: string, port: number): string {
  const host = publicHost === "0.0.0.0" || publicHost === "::" ? "127.0.0.1" : publicHost;
  return `${host}:${port}`;
}

async function main(): Promise<void> {
  const config = parseHostConfig(process.env);
  const serveStatic = process.argv.includes("--static");
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tasksRoot = path.join(
    resolveOutputDir(repositoryRoot, process.env.OUTPUT_DIR),
    "tasks",
  );

  const startedAt = performance.now();
  console.log("BioMed-QAgent starting...");

  // bootstrap（model settings / product API / db bridge / browser pool）与
  // formal runtime（含 recoverActiveRuns）都在端口绑定之后才初始化；
  // 初始化期间所有请求返回 503 {"status":"starting"}。
  let bootstrap: BootstrapOptions | undefined;
  const host = await createApplicationHost({
    publicHost: config.publicHost,
    publicPort: config.publicPort,
    onListening: (address) => {
      console.log(`  ➜ Host:  http://${bannerHost(config.publicHost, address.port)}/`);
      console.log("  ➜ State: initializing runtime...");
    },
    initializeLifecycle: async (lifecycle) => {
      const boot = await createBootstrapOptions({
        config,
        repositoryRoot,
        tasksRoot,
      });
      bootstrap = boot;
      await boot.initializeLifecycle?.(lifecycle);
    },
    hostApi: {
      handle(request, response) {
        return bootstrap?.hostApi?.handle(request, response) ?? false;
      },
    },
    formalRuntime: async () => {
      const boot = bootstrap;
      if (boot?.formalRuntime === undefined) {
        throw new Error("bootstrap not initialized before formal runtime");
      }
      return boot.formalRuntime();
    },
    frontend: (httpServer) =>
      serveStatic
        ? createStaticMiddleware(path.join(repositoryRoot, "frontend"))
        : createViteMiddleware({
            frontendRoot: path.join(repositoryRoot, "frontend"),
            httpServer,
          }),
  });

  const address = host.server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.publicPort;
  const elapsed = Math.round(performance.now() - startedAt);
  const hostname = bannerHost(config.publicHost, port);
  console.log("");
  console.log(`  BioMed-QAgent ready in ${elapsed} ms`);
  console.log(`  ➜ Local: http://${hostname}/`);
  console.log(`  ➜ API:   http://${hostname}/api/v1`);
  console.log(`  ➜ WS:    ws://${hostname}/api/v1/ws`);

  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    shutdown ??= host.close();
    return shutdown;
  };
  // tsx watch 重启进程时发 SIGTERM：优雅关闭会拖延端口释放，新进程立即
  // listen 会 EADDRINUSE。watch 场景直接退出，未终结的 run 由 durable
  // repository 在下次启动时 recoverActiveRuns() 标记 interrupted。
  process.once("SIGTERM", () => process.exit(0));
  for (const signal of ["SIGINT", "SIGHUP"] as const) {
    process.once(signal, () => {
      void close().catch((error: unknown) => {
        console.error("Application Host shutdown failed", error);
        process.exitCode = 1;
      });
    });
  }
}

main().catch((error: unknown) => {
  console.error("Application Host failed to start", error);
  process.exitCode = 1;
});
