import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createApplicationHost } from "./app/create-app.js";
import { LifecycleRegistry } from "./app/lifecycle.js";
import { createBootstrapOptions, type BootstrapOptions } from "./bootstrap.js";
import { parseHostConfig, resolveOutputDir, resolveWorkspacesRoot } from "./config.js";
import { createViteMiddleware } from "./dev/vite-middleware.js";
import { createStaticMiddleware } from "./dev/static-middleware.js";
import { acquireApplicationInstanceLock } from "./runtime/application-instance-lock.js";

function bannerHost(publicHost: string, port: number): string {
  const host = publicHost === "0.0.0.0" || publicHost === "::" ? "127.0.0.1" : publicHost;
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function installGracefulSignal(
  signal: "SIGINT" | "SIGTERM" | "SIGHUP",
  close: () => Promise<void>,
): void {
  process.once(signal, () => {
    void close().catch((error: unknown) => {
      console.error("Application Host shutdown failed", error);
      process.exitCode = 1;
    });
  });
}

async function main(): Promise<void> {
  const config = parseHostConfig(process.env);
  const serveStatic = process.argv.includes("--static");
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tasksRoot = path.join(
    resolveOutputDir(repositoryRoot, process.env.OUTPUT_DIR),
    "tasks",
  );
  const workspacesRoot = resolveWorkspacesRoot(repositoryRoot, process.env.OUTPUT_DIR);

  const startedAt = performance.now();
  const lifecycle = new LifecycleRegistry({ timeoutMs: config.shutdownTimeoutMs });
  if (serveStatic) {
    const instanceLock = await acquireApplicationInstanceLock();
    if (instanceLock.status === "already_running") {
      console.log("BioMed-QAgent is already running.");
      return;
    }
    lifecycle.add("production application instance lock", instanceLock.lease.release);
  }

  console.log("BioMed-QAgent starting...");

  // bootstrap（model settings / product API / db bridge / browser pool）与
  // formal runtime（含 recoverActiveRuns）都在端口绑定之后才初始化；
  // 初始化期间所有请求返回 503 {"status":"starting"}。
  let bootstrap: BootstrapOptions | undefined;
  const host = await createApplicationHost({
    publicHost: config.publicHost,
    publicPort: config.publicPort,
    lifecycle,
    onListening: (address) => {
      if (config.publicPort !== 0 && address.port !== config.publicPort) {
        console.warn(`Port ${config.publicPort} is already in use; using OS-assigned port ${address.port}.`);
      }
      const baseUrl = `http://${bannerHost(config.publicHost, address.port)}`;
      console.log(`BIOMED_QAGENT_URL=${baseUrl}`);
      console.log(`  ➜ Host:  ${baseUrl}/`);
      console.log("  ➜ State: initializing runtime...");
    },
    initializeLifecycle: async (lifecycle) => {
      const boot = await createBootstrapOptions({
        config,
        repositoryRoot,
        tasksRoot,
        workspacesRoot,
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
  // tsx watch 重启进程时发 SIGTERM：开发模式直接退出，未终结的 run 由
  // durable repository 在下次启动时 recoverActiveRuns() 标记 interrupted。
  // 静态生产模式则须完成有界关闭，最后释放应用单实例租约。
  if (serveStatic) installGracefulSignal("SIGTERM", close);
  else process.once("SIGTERM", () => process.exit(0));
  installGracefulSignal("SIGINT", close);
  installGracefulSignal("SIGHUP", close);
}

main().catch((error: unknown) => {
  console.error("Application Host failed to start", error);
  process.exitCode = 1;
});
