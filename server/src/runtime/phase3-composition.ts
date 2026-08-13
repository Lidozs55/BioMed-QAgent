import path from "node:path";

import type { BioMedAgentAdapter, BioMedModelConfig } from "../agent/contracts.js";
import { PiAgentAdapter } from "../agent/pi-adapter.js";
import { createDatasetBuildTools } from "../agent/tools/dataset-build.js";
import { createBusinessToolBundle } from "../agent/tools/business-tools.js";
import { createDeclarativeDatabaseTools } from "../agent/tools/declarative-db.js";
import { assertUniqueToolNames } from "../agent/tools/registry.js";
import {
  AppendOnlyTaskAuditSink,
  createTaskWorkspace,
} from "../agent/workspace/index.js";
import { createWorkspaceTools } from "../agent/workspace/tools.js";
import { DatasetCoreClient } from "../legacy/dataset-core-client.js";
import { coreEventToPayload } from "../dataset/service/events.js";
import { createDatasetCoreService } from "../dataset/service/dataset-core.js";
import { TypeScriptDatasetCore } from "../dataset/service/ts-core.js";
import { PublicHttpClient } from "../external/network/http-client.js";
import { ContentCache } from "../external/acquisition/content-cache.js";
import { DatabaseClient } from "../persistence/db-client.js";
import {
  createDurableAgentRuntime,
  type DurableAgentRuntime,
} from "./durable-agent-runtime.js";

export interface Phase3RuntimeOptions {
  tasksRoot: string;
  legacyTarget: string;
  bridgeSecret?: string;
  workspaceDevExec: boolean;
  adapter?: BioMedAgentAdapter;
  resolveModel?: () => Promise<BioMedModelConfig>;
  /** DATASET_CORE architecture flag (M2): python = legacy bridge, ts = TS core. */
  datasetCore?: "python" | "ts";
  /** Business capabilities (P5-12): DB bridge, browser pool, secrets. */
  database?: { cacheDir: string; databasesDir: string } | null;
  browserPool?: import("../external/browser/pool.js").NodeBrowserPool | null;
}

/** Phase 3 + Phase 5 composition: Pi session + full TS business tool bundle. */
export async function createPhase3Runtime(
  options: Phase3RuntimeOptions,
): Promise<DurableAgentRuntime> {
  const dbClient = options.database === undefined || options.database === null
    ? null
    : new DatabaseClient({
        cacheDir: options.database.cacheDir,
        databasesDir: options.database.databasesDir,
      });
  const runtime = await createDurableAgentRuntime({
    tasksRoot: options.tasksRoot,
    legacyBaseUrl: options.legacyTarget,
    adapter: options.adapter ?? new PiAgentAdapter({
      environment: process.env,
      resolveModel: options.resolveModel,
    }),
    workspaceFactory: async ({ taskId, runId, approvalGate, recordRunEvent }) => {
      let currentRunId = runId;
      let currentPiSessionId = "pi_session_pending";
      let buildResult: import("@biomed/contracts").BuildResult | null = null;
      const root = path.join(options.tasksRoot, taskId);
      const workspace = await createTaskWorkspace({
        taskId,
        runId,
        root,
        audit: new AppendOnlyTaskAuditSink(root),
        ...(options.workspaceDevExec
          ? { developmentExec: { enabled: true as const } }
          : {}),
      });
      const datasetCore = options.datasetCore ?? "python";
      const tsCore = new TypeScriptDatasetCore({
        taskId,
        taskRoot: root,
        eventSink: async (event, buildId) => {
          await recordRunEvent(coreEventToPayload(event, buildId));
        },
      });
      const service = createDatasetCoreService({
        datasetCore,
        tsCore: datasetCore === "ts" ? tsCore : null,
        pythonClient: datasetCore === "python"
          ? new DatasetCoreClient({
              baseUrl: options.legacyTarget,
              secret: options.bridgeSecret,
            })
          : null,
      });

      // Business tool bundle (P5-12): curated tools + dynamic user tools.
      const client = new PublicHttpClient();
      const cache = new ContentCache(path.join(root, "cache"));
      const browserPool = options.browserPool ?? null;
      let browser = null;
      if (browserPool !== null) {
        const { CrawlerFacade } = await import("../external/crawler/crawler.js");
        const crawler = new CrawlerFacade({ browserPool, client });
        browser = {
          crawler,
          cache,
          client,
          fallback: async (url: string) => {
            const result = await browserPool.fetch(url);
            return {
              status_code: result?.status_code ?? 0,
              body_text_preview: result?.content ?? "",
            };
          },
        };
      }
      const bundle = await createBusinessToolBundle({
        taskRoot: root,
        db: dbClient,
        approvalGate,
        browser,
      });
      const dynamicTools = dbClient === null
        ? []
        : await createDeclarativeDatabaseTools({
            db: dbClient,
            approval: approvalGate,
            client,
          }).catch((error: unknown) => {
            console.warn("tool.declarative_databases_unavailable", error);
            return [] as Awaited<ReturnType<typeof createDeclarativeDatabaseTools>>;
          });
      const workspaceTools = createWorkspaceTools(workspace);
      const datasetTools = createDatasetBuildTools({
        client: service,
        taskId,
        runId: () => currentRunId,
        piSessionId: () => currentPiSessionId,
        onDiagnostic: (diagnostic) => {
          console.info("tool.dataset_build", diagnostic);
        },
        onBuildResult: (result) => {
          buildResult = result;
        },
      });
      assertUniqueToolNames([...workspaceTools, ...bundle.tools, ...dynamicTools, ...datasetTools]);
      return {
        root,
        tools: [...workspaceTools, ...bundle.tools, ...dynamicTools, ...datasetTools],
        setRunId: (nextRunId: string) => {
          currentRunId = nextRunId;
          workspace.setRunId(nextRunId);
        },
        setPiSessionId: (piSessionId: string) => {
          currentPiSessionId = piSessionId;
        },
        consumeBuildResult: () => {
          const result = buildResult;
          buildResult = null;
          return result;
        },
        dispose: () => workspace.dispose(),
      };
    },
  });
  return {
    ...runtime,
    close: async () => {
      await runtime.close();
      if (dbClient !== null) await dbClient.close().catch(() => undefined);
    },
  };
}
