import path from "node:path";

import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "@biomed/contracts";

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
import { createImportTools } from "../agent/tools/import-tools.js";
import {
  AppendOnlyPermissionAuditSink,
  JsonPermissionPolicyStore,
  PermissionBroker,
  PermissionBrokerRegistry,
  PermissionEvaluator,
  ProtectedPaths,
  TemporaryGrantStore,
  type PermissionPolicyStore,
} from "../agent/permissions/index.js";
import { createChemblFilesProvider } from "../dataset/acquisition/chembl-provider.js";
import { createFixedBiomedicalProviders } from "../dataset/acquisition/biomedical-providers.js";
import {
  CoreAcquisitionRegistry,
  CoreAcquisitionRuntime,
} from "../dataset/acquisition/runtime.js";
import { coreEventToPayload } from "../dataset/service/events.js";
import { createDatasetCoreService } from "../dataset/service/dataset-core.js";
import { TypeScriptDatasetCore } from "../dataset/service/ts-core.js";
import { PublicHttpClient } from "../external/network/http-client.js";
import { ContentCache } from "../external/acquisition/content-cache.js";
import { DatabaseClient } from "../persistence/db-client.js";
import { CacheRegistrar } from "../persistence/cache-registrar.js";
import { SourceAssetRegistry } from "./source-assets/registry.js";
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
 * - Query operation ids are **call-scoped**: each ``onQueryStarted``/``onQuery``
 *   pair gets its own ``tool:<source>:query:<seq>`` id (per-source sequence),
 *   so concurrent or repeated queries from the same source no longer collide
 *   onto a single UI card. ``onQuery`` reuses the id its matching started call
 *   allocated (matched by source + query string, FIFO); terminal-only calls
 *   (older call sites without ``onQueryStarted``) still terminate with a fresh
 *   id instead of reopening a previous card. Ids are deterministic — replaying
 *   the same hook call order yields identical ids, keeping the event log
 *   reproducible.
 *   **Limitation**: the hook API carries no call token, so two *identical*
 *   query strings from the same source cannot be causality-traced; they are
 *   paired FIFO (first end closes the first start), which is deterministic but
 *   may not reflect the true start/end pairing.
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
  // Per-source sequence for call-scoped query ids (``tool:<source>:query:<seq>``)
  // and the started-but-not-yet-finished queries awaiting their terminal call.
  const querySequences = new Map<string, number>();
  const pendingQueries = new Map<
    string,
    Array<{ query: string; operationId: string }>
  >();

  const nextQueryId = (source: string): string => {
    const seq = (querySequences.get(source) ?? 0) + 1;
    querySequences.set(source, seq);
    return `tool:${source}:query:${seq}`;
  };
  // Correlate an ``onQuery`` terminal call with its ``onQueryStarted``: the
  // first pending entry for this source whose query string matches (FIFO), so
  // out-of-order completions of *different* queries still close the card their
  // own start opened. Identical query strings are indistinguishable without a
  // call token, so they pair FIFO (deterministic approximation).
  const consumeQueryId = (query: string, source: string): string => {
    const pending = pendingQueries.get(source);
    if (pending !== undefined) {
      const index = pending.findIndex((entry) => entry.query === query);
      if (index !== -1) {
        const [entry] = pending.splice(index, 1);
        if (pending.length === 0) pendingQueries.delete(source);
        return entry.operationId;
      }
    }
    return nextQueryId(source);
  };
  return {
    onQueryStarted: (query, source) => {
      const operationId = nextQueryId(source);
      const pending = pendingQueries.get(source) ?? [];
      pending.push({ query, operationId });
      pendingQueries.set(source, pending);
      void recordRunEvent({
        type: "operation_started",
        operation_id: operationId,
        label: `检索 ${QUERY_SOURCE_LABELS[source] ?? source}`,
        category: "discovery",
        attempt: 1,
      }).catch((error: unknown) => {
        console.warn("tool.query_started_event_failed", error);
      });
    },
    onQuery: (query, source, status, recordsCount = 0) => {
      const operationId = consumeQueryId(query, source);
      void recordRunEvent({
        type: "operation_progress",
        operation_id: operationId,
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
                operation_id: operationId,
                status: "failed",
                error: null,
              })
            : status === "skipped"
              ? recordRunEvent({
                  type: "operation_completed",
                  operation_id: operationId,
                  status: "skipped",
                })
              : recordRunEvent({
                  type: "operation_completed",
                  operation_id: operationId,
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
  /** Shared persistent permission settings (presets + rules). */
  permissionPolicyStore?: PermissionPolicyStore;
  /** Live permission brokers per task (preset switch invalidation, grant view/revoke). */
  permissionBrokerRegistry?: PermissionBrokerRegistry;
  adapter?: BioMedAgentAdapter;
  resolveModel?: () => Promise<BioMedModelConfig>;
  /** Limits are snapshotted whenever a new task workspace/run is created. */
  resolveRuntimeLimits?: () => RuntimeLimits;
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

export function createPhase3AcquisitionRuntime(options: {
  taskId: string;
  taskRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
}): CoreAcquisitionRuntime {
  const registry = new CoreAcquisitionRegistry();
  registry.registerProvider(createChemblFilesProvider());
  for (const provider of createFixedBiomedicalProviders()) registry.registerProvider(provider);
  return new CoreAcquisitionRuntime({
    ...options,
    sourceAssetRegistry: new SourceAssetRegistry(options.taskId, options.taskRoot),
    registry,
  });
}

/** Phase 3 + Phase 5 composition: Pi session + full TS business tool bundle. */
export async function createPhase3Runtime(
  options: Phase3RuntimeOptions,
): Promise<DurableAgentRuntime> {
  const dbClient = options.database ?? null;
  const registrar = dbClient === null
    ? null
    : new CacheRegistrar(dbClient);
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
    permissionBrokerRegistry: options.permissionBrokerRegistry,
    adapter: options.adapter ?? new PiAgentAdapter({
      environment: process.env,
      resolveModel: options.resolveModel,
    }),
    workspaceFactory: async ({ taskId, runId, approvalGate, recordRunEvent, mode }) => {
      const limits = options.resolveRuntimeLimits?.() ?? DEFAULT_RUNTIME_LIMITS;
      let currentRunId = runId;
      let currentPiSessionId = "pi_session_pending";
      let buildResult: import("@biomed/contracts").BuildResult | null = null;
      // Agent-owned directory: data/workspaces/<taskId> (plan §2.1).
      const workspaceRoot = await workspaceManager.ensure(taskId);
      // Framework-owned output: data/output/tasks/<taskId> (plan §3.2).
      const taskRoot = path.join(options.tasksRoot, taskId);
      // Permission control plane: persistent user settings + per-task broker.
      const policyStore = options.permissionPolicyStore ?? new JsonPermissionPolicyStore(
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
        limits: {
          maxReadBytes: limits.workspace_read_kib * 1024,
          maxReadCharacters: limits.workspace_read_kib * 1024,
          maxWriteBytes: limits.workspace_write_kib * 1024,
          maxSearchFileBytes: limits.workspace_search_file_mib * 1024 * 1024,
          maxSearchFiles: limits.workspace_search_max_files,
          maxExecOutputBytes: limits.command_output_kib * 1024,
          defaultExecTimeoutMs: limits.command_timeout_seconds * 1000,
          maxExecTimeoutMs: 86_400_000,
        },
      });
      const tsCore = new TypeScriptDatasetCore({
        taskId,
        taskRoot: taskRoot,
        operationTimeoutMs: options.operationTimeoutMs ?? limits.dataset_operation_timeout_seconds * 1000,
        hilGate: approvalGate,
        eventSink: async (event, buildId) => {
          await recordRunEvent(coreEventToPayload(event, buildId));
        },
      });
      const client = new PublicHttpClient({
        timeoutMs: limits.http_timeout_seconds * 1000,
      });
      const cache = new ContentCache(path.join(taskRoot, "cache"));
      const acquisitionRuntime = createPhase3AcquisitionRuntime({
        taskId,
        taskRoot,
        cache,
        client,
      });
      const service = createDatasetCoreService({
        tsCore,
        acquisition: (input) => acquisitionRuntime.acquire(input.request, input.signal),
      });

      // Business tool bundle: curated tools + dynamic user tools.
      const browserPool = options.browserPool ?? null;
      let browser = null;
      if (browserPool !== null) {
        const { CrawlerFacade } = await import("../external/crawler/crawler.js");
        const crawler = new CrawlerFacade({
          browserPool,
          client,
          minInterval: limits.request_interval_ms / 1000,
          browserTimeoutMs: limits.browser_timeout_seconds * 1000,
        });
        browser = {
          crawler,
          cache,
          client,
          fallback: async (url: string) => {
            const result = await browserPool.fetch(url, {
              timeoutMs: limits.browser_timeout_seconds * 1000,
            });
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
        hilGate: approvalGate,
        browser,
        hooks: toolHooks,
        runId: () => currentRunId,
        vlmConfig: options.vlmConfig ?? undefined,
        limits,
        registrar,
        taskId,
      });
      const dynamicTools = dbClient === null
        ? []
        : await createDeclarativeDatabaseTools({
            db: dbClient,
            approval: approvalGate,
            client,
            hooks: toolHooks,
            timeoutMs: limits.database_timeout_seconds * 1000,
          }).catch((error: unknown) => {
            console.warn("tool.declarative_databases_unavailable", error);
            return [] as Awaited<ReturnType<typeof createDeclarativeDatabaseTools>>;
          });
      const workspaceTools = createWorkspaceTools(workspace);
      const datasetTools = createDatasetBuildTools({
        client: service,
        taskId,
        taskRoot,
        runId: () => currentRunId,
        piSessionId: () => currentPiSessionId,
        onDiagnostic: (diagnostic) => {
          console.info("tool.dataset_build", diagnostic);
        },
        onBuildResult: (result) => {
          buildResult = result;
        },
        onPublication: async (data) => {
          const publication = data.publication;
          if (publication === undefined || publication === null) return;
          const manifestSha256 = publication.manifest_sha256 ?? data.manifest?.sha256;
          if (manifestSha256 === undefined) {
            throw new Error("published dataset response is missing a manifest receipt");
          }
          await recordRunEvent({
            type: "publication_created",
            publication_id: publication.publication_id,
            run_id: currentRunId,
            manifest_sha256: manifestSha256,
            supersedes_publication_id: publication.supersedes_publication_id,
            published_at: publication.published_at,
          });
          for (const artifact of data.artifacts) {
            await recordRunEvent({
              type: "artifact_produced",
              artifact: {
                artifact_id: artifact.artifact_id,
                name: artifact.name,
                role: artifact.role,
                relative_path: artifact.relative_path,
                media_type: artifact.media_type,
                size_bytes: artifact.size_bytes,
                sha256: artifact.sha256,
                generated_by_step_id: artifact.generated_by_step_id,
              },
            });
          }
        },
      });
      // Import tasks (user-uploaded files): restore the LLM cleaning flow —
      // inspect the uploaded files and commit the cleaned raw files into the
      // global cache under the user_import namespace.
      const importTools = mode === "import" && dbClient !== null
        ? createImportTools({ taskRoot, db: dbClient })
        : [];
      assertUniqueToolNames([
        ...workspaceTools,
        ...bundle.tools,
        ...dynamicTools,
        ...datasetTools,
        ...importTools,
      ]);
      return {
        root: workspaceRoot,
        tools: [
          ...workspaceTools,
          ...bundle.tools,
          ...dynamicTools,
          ...datasetTools,
          ...importTools,
        ],
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
        onRunEnd: (endedRunId: string) => {
          // Round-4 audit: run-bound temporary grants die with the run.
          grants.clearRun(endedRunId);
        },
        dispose: () => workspace.dispose(),
      };
    },
  });
  return runtime;
}
