import path from "node:path";

import type { BioMedAgentAdapter, BioMedModelConfig } from "../agent/contracts.js";
import { PiAgentAdapter } from "../agent/pi-adapter.js";
import { createDatasetBuildTools } from "../agent/tools/dataset-build.js";
import { createBusinessToolBundle } from "../agent/tools/business-tools.js";
import { createDeclarativeDatabaseTools } from "../agent/tools/declarative-db.js";
import { assertUniqueToolNames } from "../agent/tools/registry.js";
import type { ToolHooks } from "../agent/tools/tool-hooks.js";
import {
  AppendOnlyTaskAuditSink,
  createTaskWorkspace,
  DiskWorkspaceManager,
  migrateLegacyWorkspace,
  resolveWorkspacePathConfig,
  type WorkspaceManager,
} from "../agent/workspace/index.js";
import { createWorkspaceTools } from "../agent/workspace/tools.js";
import {
  AppendOnlyPermissionAuditSink,
  JsonPermissionPolicyStore,
  PermissionBroker,
  PermissionEvaluator,
  ProtectedPaths,
  TemporaryGrantStore,
} from "../agent/permissions/index.js";
import { coreEventToPayload } from "../dataset/service/events.js";
import { createDatasetCoreService } from "../dataset/service/dataset-core.js";
import { TypeScriptDatasetCore } from "../dataset/service/ts-core.js";
import { PublicHttpClient } from "../external/network/http-client.js";
import { ContentCache } from "../external/acquisition/content-cache.js";
import { DatabaseClient } from "../persistence/db-client.js";
import type { VlmConfig } from "../processing/vlm/vlm-client.js";
import {
  createDurableAgentRuntime,
  type DurableAgentRuntime,
} from "./durable-agent-runtime.js";

/**
 * Display names for query sources used in operation_started labels
 * (mirrors the frontend toolLabels.ts search entries so both bubbles of a
 * tool call read consistently).
 */
const QUERY_SOURCE_LABELS: Readonly<Record<string, string>> = {
  local_cache: "本地缓存",
  pubchem: "PubChem",
  xena: "Xena",
  pubmed: "PubMed",
  gdc: "GDC",
  geo: "GEO",
  reactome: "Reactome",
  chembl: "ChEMBL",
  uniprot: "UniProt",
  pdb: "PDB",
  browser: "网页",
  pdf_extraction: "PDF",
  analysis: "分析",
  literature_understanding: "文献",
};

/**
 * Tool query/progress hooks projected onto the V2 operation lifecycle
 * (Design §15.1): ``operation_started`` opens a card, ``operation_progress``
 * updates it, ``operation_completed``/``operation_failed`` close it.
 *
 * - ``onQueryStarted``/``onQuery`` pair per query: started fires when the
 *   query begins, the terminal event when it ends (success/not_found /
 *   page_fallback → succeeded, skipped → skipped, failed → failed).
 * - ``onProgress`` opens progress-only operations (``tool:discovery:*``,
 *   ``tool:acquisition:*``) once per run — they have no natural end signal,
 *   so the run-terminal fallback on the frontend closes them.
 *
 * ``currentRunId`` must be a getter: the workspace outlives runs and the
 * dedup key must not leak state across runs.
 */
export function createPhase3ToolHooks(
  recordRunEvent: (payload: import("@biomed/contracts").EventPayload) => Promise<void>,
  currentRunId: () => string,
): ToolHooks {
  const startedProgressOps = new Set<string>();
  return {
    onQueryStarted: (_query, source) => {
      void recordRunEvent({
        type: "operation_started",
        operation_id: `tool:${source}:query`,
        label: `检索 ${QUERY_SOURCE_LABELS[source] ?? source}`,
        category: "discovery",
        attempt: 1,
      }).catch((error: unknown) => {
        console.warn("tool.query_started_event_failed", error);
      });
    },
    onQuery: (query, source, status, recordsCount = 0) => {
      void recordRunEvent({
        type: "operation_progress",
        operation_id: `tool:${source}:query`,
        kind: "query",
        current: Math.max(0, recordsCount),
        total: null,
        detail: {
          source,
          status,
          query: String(query).slice(0, 200),
        },
      })
        .then(() =>
          // Close the query lifecycle opened by onQueryStarted. Queries
          // without a started event (older call sites) still terminate
          // instead of lingering "running" forever.
          status === "failed"
            ? recordRunEvent({
                type: "operation_failed",
                operation_id: `tool:${source}:query`,
                status: "failed",
                error: null,
              })
            : status === "skipped"
              ? recordRunEvent({
                  type: "operation_completed",
                  operation_id: `tool:${source}:query`,
                  status: "skipped",
                })
              : recordRunEvent({
                  type: "operation_completed",
                  operation_id: `tool:${source}:query`,
                  status: "succeeded",
                }),
        )
        .catch((error: unknown) => {
          console.warn("tool.query_event_failed", error);
        });
    },
    onProgress: (stage, kind, payload) => {
      const operationId = `tool:${stage}:${kind}`;
      const runKey = `${currentRunId()}:${operationId}`;
      const started =
        stage === "discovery"
          ? { label: "发现记录", category: "discovery" }
          : stage === "acquisition"
            ? { label: "下载数据", category: "acquisition" }
            : { label: stage, category: null };
      const startedEvent = startedProgressOps.has(runKey)
        ? null
        : recordRunEvent({
            type: "operation_started",
            operation_id: operationId,
            label: started.label,
            ...(started.category === null ? {} : { category: started.category }),
            attempt: 1,
          }).then(() => {
            startedProgressOps.add(runKey);
          });
      const progressEvent = recordRunEvent({
        type: "operation_progress",
        operation_id: operationId,
        kind,
        current: Number(payload.current) || 0,
        total: payload.total === null || payload.total === undefined
          ? null
          : Number(payload.total),
        detail: payload as Record<string, import("@biomed/contracts").JsonValue>,
      });
      void Promise.allSettled([startedEvent, progressEvent]).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            console.warn("tool.progress_event_failed", result.reason);
          }
        }
      });
    },
  };
}

export interface Phase3RuntimeOptions {
  tasksRoot: string;
  /** Agent workspace root (``data/workspaces``) — decoupled from output. */
  workspacesRoot: string;
  /** Repository root used by the permission classifier. */
  repositoryRoot: string;
  /** Migration override for process.exec policy (plan §58). */
  agentExecPolicy: "deny" | "ask" | "allow" | null;
  adapter?: BioMedAgentAdapter;
  resolveModel?: () => Promise<BioMedModelConfig>;
  /**
   * Operation wall-clock timeout in ms for the TS Dataset Core.
   * Defaults to 120_000 (120 s), matching the retired Python baseline
   * executor (``backend/app/datasets/runtime/executor.py``).
   */
  operationTimeoutMs?: number;
  /** Business capabilities: DB bridge, browser pool, secrets. */
  database?: DatabaseClient | null;
  browserPool?: import("../external/browser/pool.js").NodeBrowserPool | null;
  /** VLM chart-extraction config; missing fields keep env defaults. */
  vlmConfig?: Partial<VlmConfig> | null;
}

/** Phase 3 + Phase 5 composition: Pi session + full TS business tool bundle. */
export async function createPhase3Runtime(
  options: Phase3RuntimeOptions,
): Promise<DurableAgentRuntime> {
  const dbClient = options.database ?? null;
  const workspaceManager: WorkspaceManager = new DiskWorkspaceManager({
    workspacesRoot: options.workspacesRoot,
    migrateLegacy: async (taskId, workspaceRoot) => {
      await migrateLegacyWorkspace({
        taskId,
        workspaceRoot,
        taskOutputRoot: path.join(options.tasksRoot, taskId),
      });
    },
  });
  const pathConfig = resolveWorkspacePathConfig({
    repositoryRoot: options.repositoryRoot,
    workspacesRoot: options.workspacesRoot,
    tasksRoot: options.tasksRoot,
  });
  const runtime = await createDurableAgentRuntime({
    tasksRoot: options.tasksRoot,
    workspaceManager,
    adapter: options.adapter ?? new PiAgentAdapter({
      environment: process.env,
      resolveModel: options.resolveModel,
    }),
    workspaceFactory: async ({ taskId, runId, approvalGate, recordRunEvent }) => {
      let currentRunId = runId;
      let currentPiSessionId = "pi_session_pending";
      let buildResult: import("@biomed/contracts").BuildResult | null = null;
      // Agent-owned directory: data/workspaces/<taskId> (plan §2.1).
      const workspaceRoot = await workspaceManager.ensure(taskId);
      // Framework-owned output: data/output/tasks/<taskId> (plan §3.2).
      const taskRoot = path.join(options.tasksRoot, taskId);
      // Permission control plane: persistent user settings + per-task broker.
      const policyStore = new JsonPermissionPolicyStore(
        path.join(pathConfig.dataRoot, "settings", "agent-permissions.json"),
      );
      const grants = new TemporaryGrantStore();
      const protectedPaths = new ProtectedPaths({ taskOutputRoot: taskRoot });
      const permissionAudit = new AppendOnlyPermissionAuditSink(taskRoot);
      const permissionBroker = new PermissionBroker({
        taskId,
        runId,
        evaluator: new PermissionEvaluator({
          protectedPaths,
          grants,
          policyStore,
          execPolicyOverride: options.agentExecPolicy ?? undefined,
        }),
        grants,
        policyStore,
        audit: permissionAudit,
        recordRunEvent,
      });
      const workspace = await createTaskWorkspace({
        taskId,
        runId,
        workspaceRoot,
        taskOutputRoot: taskRoot,
        dataRoot: pathConfig.dataRoot,
        repositoryRoot: options.repositoryRoot,
        permissions: permissionBroker,
        audit: new AppendOnlyTaskAuditSink(taskRoot),
      });
      const tsCore = new TypeScriptDatasetCore({
        taskId,
        taskRoot: taskRoot,
        operationTimeoutMs: options.operationTimeoutMs ?? 120_000,
        eventSink: async (event, buildId) => {
          await recordRunEvent(coreEventToPayload(event, buildId));
        },
      });
      const service = createDatasetCoreService({ tsCore });

      // Business tool bundle: curated tools + dynamic user tools.
      const client = new PublicHttpClient();
      const cache = new ContentCache(path.join(taskRoot, "cache"));
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
      // Progress-only operations (discovery/download aggregation) have no
      // natural end signal; open each once per run so the frontend card
      // gets a label, and the run-terminal fallback closes it.
      const toolHooks = createPhase3ToolHooks(
        recordRunEvent,
        () => currentRunId,
      );
      const bundle = await createBusinessToolBundle({
        taskRoot: taskRoot,
        db: dbClient,
        approvalGate,
        browser,
        hooks: toolHooks,
        runId: () => currentRunId,
        vlmConfig: options.vlmConfig ?? undefined,
      });
      const dynamicTools = dbClient === null
        ? []
        : await createDeclarativeDatabaseTools({
            db: dbClient,
            approval: approvalGate,
            client,
            hooks: toolHooks,
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
        root: workspaceRoot,
        tools: [...workspaceTools, ...bundle.tools, ...dynamicTools, ...datasetTools],
        permissionBroker,
        setRunId: (nextRunId: string) => {
          currentRunId = nextRunId;
          workspace.setRunId(nextRunId);
          permissionBroker.bindRun(nextRunId);
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
  return runtime;
}
