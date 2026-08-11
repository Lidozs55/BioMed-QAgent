import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApplicationHost } from "./app/create-app.js";
import { LifecycleRegistry } from "./app/lifecycle.js";
import { createExperimentalPiRuntime } from "./agent/experimental-pi.js";
import { PiAgentAdapter } from "./agent/pi-adapter.js";
import {
  AppendOnlyTaskAuditSink,
  createTaskWorkspace,
} from "./agent/workspace/index.js";
import { createWorkspaceTools } from "./agent/workspace/tools.js";
import { parseHostConfig } from "./config.js";
import { createViteMiddleware } from "./dev/vite-middleware.js";
import { createLegacyBackend } from "./legacy/backend-process.js";

async function main(): Promise<void> {
  const config = parseHostConfig(process.env);
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tasksRoot = path.join(
    path.resolve(process.env.OUTPUT_DIR ?? path.join(repositoryRoot, "backend", "data", "output")),
    "tasks",
  );
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
    initializeLifecycle: async () => undefined,
    experimentalPi: config.flags.piExperimental
      ? () =>
          createExperimentalPiRuntime({
            adapter: new PiAgentAdapter({ environment: process.env }),
            workspaceFactory: async ({ taskId, runId }) => {
              const root = path.join(tasksRoot, taskId);
              const workspace = await createTaskWorkspace({
                taskId,
                runId,
                root,
                audit: new AppendOnlyTaskAuditSink(root),
                ...(config.workspaceDevExec
                  ? { developmentExec: { enabled: true as const } }
                  : {}),
              });
              return {
                root,
                tools: createWorkspaceTools(workspace),
                dispose: () => workspace.dispose(),
              };
            },
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
