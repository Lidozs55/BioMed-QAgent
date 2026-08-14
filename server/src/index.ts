import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationHost } from "./app/create-app.js";
import { LifecycleRegistry } from "./app/lifecycle.js";
import { createPhase1ExperimentalRuntime } from "./agent/phase1-composition.js";
import { parseHostConfig } from "./config.js";
import { createViteMiddleware } from "./dev/vite-middleware.js";
import { createLegacyBackend } from "./legacy/backend-process.js";
import { createPhase3Runtime } from "./runtime/phase3-composition.js";
import { ModelSettingsService } from "./settings/model-settings.js";
import { NodeBrowserPool } from "./external/browser/index.js";

async function main(): Promise<void> {
  const config = parseHostConfig(process.env);
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outputRoot = path.resolve(
    process.env.OUTPUT_DIR ?? path.join(repositoryRoot, "backend", "data", "output"),
  );
  const tasksRoot = path.join(outputRoot, "tasks");
  const dataDir = path.resolve(outputRoot, "..");
  const cacheDir = path.join(dataDir, "cache");
  const databasesDir = path.join(dataDir, "skills");
  const settingsDir = path.resolve(tasksRoot, "..", "..", "settings");
  const modelSettings = await ModelSettingsService.create({
    settingsDir,
    legacyRegistryPath: path.join(settingsDir, "model_registry.db"),
    environment: process.env,
  });
  const vlmConfig = await modelSettings.resolveVlmConfig().catch(() => undefined);
  const browserPool = config.flags.agentRuntime === "pi"
    ? new NodeBrowserPool({ maxContexts: 4 })
    : null;
  const lifecycle = new LifecycleRegistry({ timeoutMs: config.shutdownTimeoutMs + 5_000 });
  if (browserPool !== null) {
    lifecycle.add("Node browser pool", () => browserPool.close());
    await browserPool.start();
  }
  const host = await createApplicationHost({
    publicHost: config.publicHost,
    publicPort: config.publicPort,
    lifecycle,
    legacy: () =>
      createLegacyBackend({
        repositoryRoot,
        privatePort: config.legacyPrivatePort,
        legacyUrl: config.legacyUrl,
        bridgeSecret: config.legacyBridgeSecret,
        readinessTimeoutMs: config.legacyReadinessTimeoutMs,
        shutdownTimeoutMs: config.shutdownTimeoutMs,
      }),
    initializeLifecycle: async () => undefined,
    hostApi: config.flags.agentRuntime === "pi" ? modelSettings : undefined,
    formalRuntime: config.flags.agentRuntime === "pi"
      ? ({ target, bridgeSecret }) =>
          createPhase3Runtime({
            tasksRoot,
            legacyTarget: target,
            bridgeSecret,
            workspaceDevExec: config.workspaceDevExec,
            resolveModel: modelSettings.resolveActiveModel,
            datasetCore: config.flags.datasetCore,
            database: { cacheDir, databasesDir },
            browserPool,
            vlmConfig,
          })
      : undefined,
    experimentalPi: config.flags.piExperimental
      ? ({ target, bridgeSecret }) =>
          createPhase1ExperimentalRuntime({
            repositoryRoot,
            tasksRoot,
            legacyTarget: target,
            bridgeSecret,
            workspaceDevExec: config.workspaceDevExec,
            resolveModel: modelSettings.resolveActiveModel,
          })
      : undefined,
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
