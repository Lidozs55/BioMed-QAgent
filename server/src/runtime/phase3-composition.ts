import { randomUUID } from "node:crypto";
import path from "node:path";

import { DEFAULT_RUNTIME_LIMITS, type DiscoveryQueryRecord, type RuntimeLimits } from "@biomed/contracts";

import type { BioMedAgentAdapter, BioMedModelConfig } from "../agent/contracts.js";
import { PiAgentAdapter } from "../agent/pi-adapter.js";
import { createDatasetExecutionTools } from "../agent/tools/dataset-execution.js";
import { createSupplementaryArchiveExtractionTool } from "../agent/tools/supplementary-archive.js";
import {
  createDatasetProfileScaffoldTool,
  createDatasetRoutePreflightTool,
} from "../agent/tools/dataset-route-preflight.js";
import { createCoreAssetTools } from "../agent/tools/core-asset-tools.js";
import {
  createDynamicFamilyPublicationTool,
  dynamicFamilyPublicationWire,
  parseDynamicFamilyPublicationSubmission,
  createPrepareDynamicFamilyPublicationTool,
  type ParsedDynamicFamilyPublicationSubmission,
} from "../agent/tools/dynamic-family-publication.js";
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
import { createCoreAcquisitionProviders } from "../dataset/acquisition/provider-catalog.js";
import { EXTENDED_PROVIDER_IDS } from "../dataset/acquisition/extended-providers.js";
import { extractRegisteredZipMembers } from "../dataset/archive/zip-members.js";
import { parseRegisteredArchiveMembers } from "../dataset/archive/member-parsers.js";
import { createDefaultDatasetFamilyRegistry } from "../dataset/families/index.js";
import {
  CoreAcquisitionRegistry,
  CoreAcquisitionRuntime,
} from "../dataset/acquisition/runtime.js";
import { coreEventToPayload } from "../dataset/service/events.js";
import { createDatasetCoreService } from "../dataset/service/dataset-core.js";
import { acquireExecutionLock } from "../dataset/service/execution-lock.js";
import { submitDynamicFamilyPublication } from "../dataset/dynamic-family/submission.js";
import {
  dynamicFamilyPreflightSubmissionDigest,
  prepareDynamicFamilyPublication,
  validateDynamicFamilyPreflightReceipt,
} from "../dataset/dynamic-family/preflight.js";
import type { DynamicFamilyAcquisitionPlanningInput } from "../dataset/dynamic-family/preflight.js";
import { publishDynamicFamily } from "../dataset/dynamic-family/publication.js";
import {
  resolveCoreProductTopologyRequirements,
} from "../dataset/dynamic-family/product-requirement-registry.js";
import type { CoreProductTopologyRequirements } from "../dataset/dynamic-family/product-requirements.js";
import { TypeScriptDatasetCore } from "../dataset/service/ts-core.js";
import { BrowserParserRecipeRegistry, createDefaultBrowserParserRecipeRegistry } from "../dataset/acquisition/browser-recipe-registry.js";
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
import { createHilGatePreReview } from "./hil-pre-review.js";
import type { HILApprovalPolicyStore } from "./hil-approval-store.js";
import { createDynamicFamilyPreflightCoordinator } from "./dynamic-family-preflight-coordinator.js";
import {
  archiveCommittedDynamicTablesAsUntrustedArtifacts,
  classifyDynamicPublicationRejection,
  DynamicPublicationUntrustedFallbackError as UntrustedFallbackError,
} from "./dynamic-family-untrusted-fallback.js";

export { createDynamicFamilyPreflightCoordinator } from "./dynamic-family-preflight-coordinator.js";

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
 *   allocated. ``onQueryStarted`` returns an opaque call token that ``onQuery``
 *   can pass back to preserve causality even when identical same-source calls
 *   finish out of order. Callers that omit the token retain deterministic
 *   source + query FIFO pairing; terminal-only calls still receive a fresh id.
 *   Ids are deterministic — replaying the same hook call order yields identical
 *   ids, keeping the event log reproducible.
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
  // Discovery ledger (source coverage evidence): one record per terminal
  // onQuery call, handed to the Dataset Core at execute time and projected
  // from persisted events on recovery (discovery-ledger.ts).
  const discoveryRecords: DiscoveryQueryRecord[] = [];
  // Per-source sequence for call-scoped query ids (``tool:<source>:query:<seq>``)
  // and the started-but-not-yet-finished queries awaiting their terminal call.
  const querySequences = new Map<string, number>();
  interface PendingQuery {
    query: string;
    source: string;
    operationId: string;
  }
  const pendingQueries = new Map<string, PendingQuery[]>();
  const pendingQueryTokens = new Map<object, PendingQuery>();

  const nextQueryId = (source: string): string => {
    const seq = (querySequences.get(source) ?? 0) + 1;
    querySequences.set(source, seq);
    return `tool:${source}:query:${seq}`;
  };
  const removePendingQuery = (entry: PendingQuery): void => {
    const pending = pendingQueries.get(entry.source);
    const index = pending?.indexOf(entry) ?? -1;
    if (pending !== undefined && index !== -1) {
      pending.splice(index, 1);
      if (pending.length === 0) pendingQueries.delete(entry.source);
    }
  };
  // Prefer exact token correlation. Legacy callers that omit a token consume
  // the first matching source + query entry (FIFO), preserving prior behavior.
  const consumeQueryId = (query: string, source: string, callToken?: unknown): string => {
    if (callToken !== undefined) {
      const tokenEntry = typeof callToken === "object" && callToken !== null
        ? pendingQueryTokens.get(callToken)
        : undefined;
      if (tokenEntry !== undefined && tokenEntry.source === source) {
        pendingQueryTokens.delete(callToken as object);
        removePendingQuery(tokenEntry);
        return tokenEntry.operationId;
      }
      return nextQueryId(source);
    }

    const pending = pendingQueries.get(source);
    const index = pending?.findIndex((entry) => entry.query === query) ?? -1;
    if (pending !== undefined && index !== -1) {
      const [entry] = pending.splice(index, 1);
      if (pending.length === 0) pendingQueries.delete(source);
      for (const [token, tokenEntry] of pendingQueryTokens) {
        if (tokenEntry === entry) {
          pendingQueryTokens.delete(token);
          break;
        }
      }
      return entry.operationId;
    }
    return nextQueryId(source);
  };
  return {
    discoveryLedger: (): DiscoveryQueryRecord[] => [...discoveryRecords],
    onQueryStarted: (query, source) => {
      const operationId = nextQueryId(source);
      const entry = { query, source, operationId };
      const callToken = Object.freeze({ operationId });
      const pending = pendingQueries.get(source) ?? [];
      pending.push(entry);
      pendingQueries.set(source, pending);
      pendingQueryTokens.set(callToken, entry);
      void recordRunEvent({
        type: "operation_started",
        operation_id: operationId,
        label: `检索 ${QUERY_SOURCE_LABELS[source] ?? source}`,
        category: "discovery",
        attempt: 1,
      }).catch((error: unknown) => {
        console.warn("tool.query_started_event_failed", error);
      });
      return callToken;
    },
    onQuery: (query, source, status, recordsCount = 0, callToken) => {
      const operationId = consumeQueryId(query, source, callToken);
      discoveryRecords.push({
        operation_id: operationId,
        source,
        query,
        status,
        result_count: Math.max(0, recordsCount),
        requested_limit: null,
        retrieved_at: new Date().toISOString(),
      });
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
  /**
   * Shared three-tier HIL approval settings store (human_review /
   * llm_pre_review / auto_approve per scope). Combined with ``resolveModel``
   * it enables the LLM pre-review stage in the HIL gate.
   */
  hilApprovalPolicy?: HILApprovalPolicyStore;
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
  /**
   * VLM chart-extraction config resolver; consulted per governed extraction
   * call (not snapshotted at composition time), so visual-model role changes
   * apply without a restart. The resolved API key stays in memory only.
   */
  resolveVlmConfig?: () => Promise<VlmConfig>;
  /**
   * Transport for governed visual-model calls. Defaults to the shared policy
   * client; composition hosts (evaluation harnesses) inject a fixture
   * transport so the fake visual model stays behind the same URL policy
   * without network access.
   */
  vlmHttpClient?: PublicHttpClient;
  /** Core-promoted browser parser registry shared by all task runs. */
  browserRecipeRegistry?: BrowserParserRecipeRegistry;
  /**
   * Trusted composition seams used by production fixtures to observe the
   * acquisition/transform/publication boundary without replacing phase3.
   */
  dynamicFamilySeams?: Phase3DynamicFamilySeams;
}

export type Phase3AcquisitionRuntime = Pick<CoreAcquisitionRuntime, "plan" | "acquire">;

export interface Phase3DynamicFamilySeams {
  readonly createAcquisitionRuntime?: (options: {
    taskId: string;
    taskRoot: string;
    cache: ContentCache;
    client: PublicHttpClient;
    sourceAssetRegistry: SourceAssetRegistry;
    registrar: CacheRegistrar | null;
  }) => Phase3AcquisitionRuntime;
  readonly submitDynamicFamilyPublication?: typeof submitDynamicFamilyPublication;
  readonly publishDynamicFamily?: typeof publishDynamicFamily;
  /** Test-only Core product profile resolver. Production uses the trusted registry. */
  readonly resolveProductRequirements?: (profileRef: string) => CoreProductTopologyRequirements;
  /** Test-only observation seam for deterministic final-fence races. */
  readonly assertExecutionLockOwned?: (assertOwned: () => Promise<boolean>) => Promise<boolean>;
  /** Test-only gate immediately before the publisher's final rename fence. */
  readonly beforeDynamicFamilyFinalFence?: () => Promise<void>;
}

export function createPhase3AcquisitionRuntime(options: {
  taskId: string;
  taskRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  sourceAssetRegistry?: SourceAssetRegistry;
  registrar?: CacheRegistrar | null;
}): CoreAcquisitionRuntime {
  const registry = new CoreAcquisitionRegistry();
  for (const provider of createCoreAcquisitionProviders()) registry.registerProvider(provider);
  return new CoreAcquisitionRuntime({
    ...options,
    sourceAssetRegistry: options.sourceAssetRegistry ?? new SourceAssetRegistry(options.taskId, options.taskRoot),
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
    hilPreReview: createHilGatePreReview(
      options.hilApprovalPolicy ?? null,
      options.resolveModel ?? null,
    ),
    adapter: options.adapter ?? new PiAgentAdapter({
      resolveModel: options.resolveModel,
    }),
    workspaceFactory: async ({ taskId, runId, approvalGate, recordRunEvent, mode }) => {
      const limits = options.resolveRuntimeLimits?.() ?? DEFAULT_RUNTIME_LIMITS;
      let currentRunId = runId;
      let currentPiSessionId = "pi_session_pending";
      let currentPublicationId: string | null = null;
      // Agent-owned directory: data/workspaces/<taskId> (plan §2.1).
      const workspaceRoot = await workspaceManager.ensure(taskId);
      // Framework-owned output: data/output/tasks/<taskId> (plan §3.2).
      const taskRoot = path.join(options.tasksRoot, taskId);
      const dynamicFamilyPreflight = createDynamicFamilyPreflightCoordinator({
        stateFile: path.join(taskRoot, "state", "dynamic-family-preflight.json"),
      });
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
        eventSink: async (event, requirementId) => {
          await recordRunEvent(coreEventToPayload(event, requirementId));
        },
      });
      const client = new PublicHttpClient({
        timeoutMs: limits.http_timeout_seconds * 1000,
      });
      const cache = new ContentCache(path.join(taskRoot, "cache"));
      const sourceAssetRegistry = new SourceAssetRegistry(taskId, taskRoot);
      const browserRecipeRegistry = options.browserRecipeRegistry ?? createDefaultBrowserParserRecipeRegistry();
      const acquisitionRuntime = options.dynamicFamilySeams?.createAcquisitionRuntime?.({
        taskId,
        taskRoot,
        cache,
        client,
        sourceAssetRegistry,
        registrar,
      }) ?? createPhase3AcquisitionRuntime({
        taskId,
        taskRoot,
        cache,
        client,
        sourceAssetRegistry,
        registrar,
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
        workspaceRoot,
        db: dbClient,
        approvalGate,
        hilGate: approvalGate,
        browser,
        hooks: toolHooks,
        runId: () => currentRunId,
        resolveVlmConfig: options.resolveVlmConfig,
        vlmHttpClient: options.vlmHttpClient,
        limits,
        registrar,
        taskId,
        sourceAssetRegistry,
        browserRecipeRegistry,
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
      const planCoreAcquisition = async (
        submission: ParsedDynamicFamilyPublicationSubmission,
        { binding, request }: DynamicFamilyAcquisitionPlanningInput,
      ) => acquisitionRuntime.plan({
        schema_version: "1.0",
        request_id: `preflight_${submission.execution_proposal.requirement_id}_${binding.binding_id}`,
        task_id: taskId,
        requirement_id: submission.execution_proposal.requirement_id,
        binding_id: binding.binding_id,
        mode: "builtin",
        provider_id: request.provider_id,
        recipe_id: null,
        recipe_version: null,
        parameters: { ...request.parameters },
      });
      const dynamicFamilyPrepareTool = createPrepareDynamicFamilyPublicationTool({
        prepare: async (submission) => {
          const productRequirements = (
            options.dynamicFamilySeams?.resolveProductRequirements
            ?? resolveCoreProductTopologyRequirements
          )(submission.family_spec.assessment_policy_ref);
          const preparation = await dynamicFamilyPreflight.beginPrepare(submission.execution_proposal.requirement_id);
          const receipt = await prepareDynamicFamilyPublication({
            taskId,
            requirementId: submission.execution_proposal.requirement_id,
            generation: preparation.generation,
            submission,
            productRequirements,
            runtimeLimits: limits,
            planAcquisition: (planning) => planCoreAcquisition(submission, planning),
          });
          await dynamicFamilyPreflight.commitPrepare(
            preparation,
            receipt,
            dynamicFamilyPreflightSubmissionDigest(submission),
            dynamicFamilyPublicationWire(submission, receipt.host_descriptor_digest),
          );
          return receipt;
        },
      });
      const dynamicFamilyTool = createDynamicFamilyPublicationTool({
        // The coordinator stores the JSON wire form returned by prepare. The
        // submit path needs the derived `.projection` (and digest-bound parsed
        // facts), so the stored wire is re-parsed here instead of trusting a
        // closure variable: the wire is the authoritative prepared_submission
        // copy and its digest chain is anchored by the receipt, so re-parsing
        // is byte-safe. Without this, a fresh closure (task resume, run
        // recovery, rebuilt workspace) resolves a wire with `.projection ===
        // undefined` and the submission chain throws `Expected object at
        // $projection` (model-blockers wire row, 5/5 dynamic gold runs).
        resolveSubmission: async (preflightReceipt) =>
          parseDynamicFamilyPublicationSubmission(
            await dynamicFamilyPreflight.resolveSubmission(preflightReceipt),
          ),
        submit: async (submission, signal, _context, preflightReceipt) => {
          if (preflightReceipt === undefined) {
            throw new Error("submit_dynamic_family_publication requires a preflight receipt");
          }
          const productRequirements = (
            options.dynamicFamilySeams?.resolveProductRequirements
            ?? resolveCoreProductTopologyRequirements
          )(submission.family_spec.assessment_policy_ref);
          await validateDynamicFamilyPreflightReceipt({
            receipt: preflightReceipt,
            submission,
            taskId,
            requirementId: submission.execution_proposal.requirement_id,
            generation: preflightReceipt.generation,
            runtimeLimits: limits,
            planAcquisition: (planning) => planCoreAcquisition(submission, planning),
            productRequirements,
          });
          const executionLock = await acquireExecutionLock(
            { lockRoot: path.join(taskRoot, "state", "execution-locks") },
            taskId,
            submission.execution_proposal.requirement_id,
            `dynamic-family:${currentRunId}:${randomUUID()}`,
          );
          const assertExecutionLockOwned = (): Promise<boolean> => {
            const seam = options.dynamicFamilySeams?.assertExecutionLockOwned;
            return seam === undefined ? executionLock.assertOwned() : seam(() => executionLock.assertOwned());
          };
          let reservation: Awaited<ReturnType<typeof dynamicFamilyPreflight.reserve>> | null = null;
          try {
            reservation = await dynamicFamilyPreflight.reserve(
              preflightReceipt,
              dynamicFamilyPreflightSubmissionDigest(submission),
            );
          const registeredSources: Record<string, string> = { ...submission.registered_sources };
          const acquisitionRequestDigests: Record<string, string> = {};
          const planByBinding = new Map(
            preflightReceipt.acquisition_plan.map((entry) => [entry.binding_id, entry]),
          );
          for (const [bindingId, request] of Object.entries(submission.acquisition_requests)) {
            if (!dynamicFamilyPreflight.isCurrent(reservation)) {
              throw new Error("dynamic family preflight generation is stale");
            }
            const acquired = await acquisitionRuntime.acquire({
              schema_version: "1.0",
              request_id: `request_${randomUUID()}`,
              task_id: taskId,
              requirement_id: submission.execution_proposal.requirement_id,
              binding_id: bindingId,
              mode: "builtin",
              provider_id: request.provider_id,
              recipe_id: null,
              recipe_version: null,
              parameters: { ...request.parameters },
            }, signal);
            const planned = planByBinding.get(bindingId);
            if (
              planned?.mode !== "builtin"
              || planned.provider_id !== request.provider_id
              || planned.request_digest !== acquired.requestIdentityDigest
            ) {
              throw new Error(`Core acquisition identity drifted for binding '${bindingId}'`);
            }
            if (acquired.sourceAsset === null) {
              throw new Error(`Core acquisition did not register source binding '${bindingId}'`);
            }
            registeredSources[bindingId] = acquired.sourceAsset.asset_id;
            acquisitionRequestDigests[bindingId] = acquired.requestIdentityDigest;
          }
          if (!dynamicFamilyPreflight.isCurrent(reservation)) {
            throw new Error("dynamic family preflight generation is stale");
          }
          const resolvedSubmission = Object.freeze({
            ...submission,
            registered_sources: Object.freeze(registeredSources),
            acquisition_requests: Object.freeze({}),
          });
          const result = await (options.dynamicFamilySeams?.submitDynamicFamilyPublication ?? submitDynamicFamilyPublication)({

            taskId,
            runId: currentRunId,
            submission: resolvedSubmission,
            sourceAssetRegistry,
            taskRoot,
            runtimeLimits: limits,
            generation: preflightReceipt.generation,
            preflightReceipt,
            preflightSubmission: submission,
            productRequirements,
            planAcquisition: (planning) => planCoreAcquisition(submission, planning),
            isGenerationCurrent: (candidateGeneration, cancelFence) =>
              candidateGeneration === reservation?.generation
              && reservation !== null
              && dynamicFamilyPreflight.isCurrent(reservation)
              && cancelFence.length > 0,
            sourceAcquisitionRequestDigests: Object.freeze(acquisitionRequestDigests),
            signal,
          });
          if (!(await assertExecutionLockOwned())) {
            throw new Error("dynamic family execution lock fence was lost");
          }
          if (!dynamicFamilyPreflight.isCurrent(reservation)) {
            throw new Error("dynamic family preflight generation is stale");
          }
          let product: Awaited<ReturnType<typeof publishDynamicFamily>>;
          try {
            product = await (options.dynamicFamilySeams?.publishDynamicFamily ?? publishDynamicFamily)({
              taskId,
              taskRoot,
              workspaceRoot,
              runId: currentRunId,
              requirementId: submission.execution_proposal.requirement_id,
              execution: result,
              validationProfileRef: submission.family_spec.validation_policy_ref,
              productRequirements,
              hilGate: approvalGate,
              signal,
              isGenerationCurrent: async () =>
                reservation !== null
                && await assertExecutionLockOwned()
                && dynamicFamilyPreflight.isCurrent(reservation),
              beforeFinalFence: options.dynamicFamilySeams?.beforeDynamicFamilyFinalFence,
            });
          } catch (publicationError) {
            // Gold6 R4 automatic untrusted-artifact fallback: after a fully
            // committed dynamic execution, a semantic/publication rejection
            // archives the candidate tables once into the non-authoritative
            // quarantine (never a publication, artifact event, or formal
            // success), then rethrows the formal rejection with ua_* receipts
            // attached for the tool response projection.
            const message = publicationError instanceof Error
              ? publicationError.message
              : String(publicationError);
            const cause = publicationError instanceof Error && publicationError.cause instanceof Error
              ? publicationError.cause
              : null;
            if (classifyDynamicPublicationRejection(message) === "semantic_rejection") {
              try {
                const receipts = await archiveCommittedDynamicTablesAsUntrustedArtifacts({
                  result,
                  taskId,
                  taskRoot,
                  runId: currentRunId,
                  requirementId: submission.execution_proposal.requirement_id,
                  rejectionReason: message,
                  failedChecks: UntrustedFallbackError.extractFailedChecks(publicationError),
                });
                throw new UntrustedFallbackError({
                  message,
                  untrustedArtifacts: receipts,
                });
              } catch (fallbackError) {
                if (fallbackError instanceof UntrustedFallbackError) throw fallbackError;
                // A failed archive (including the helper's own integrity
                // re-verification) stays a hard reject without ua_* output;
                // the original publication error remains authoritative.
                const fallbackNote = `untrusted artifact fallback failed: ${fallbackError instanceof Error ? fallbackError.message.slice(0, 300) : String(fallbackError)}`;
                console.warn("runtime.dynamic_publication_untrusted_fallback", {
                  classification: "semantic_rejection",
                  detail: fallbackNote,
                });
                throw cause === null
                  ? new Error(`${message}; ${fallbackNote}`)
                  : new Error(`${message} (fallback diagnostic: ${cause.message})`);
              }
            }
            // Integrity/control failures (cancellation, stale generation,
            // lock loss, refusal at the promotion fence, identity mismatch,
            // path traversal, byte drift) never archive: hard reject with no
            // ua_* output, preserving the original publication error.
            throw publicationError;
          }
          const publicationManifestSha = product.publication.publication.manifest_sha256;
          if (publicationManifestSha === undefined) {
            throw new Error("dynamic publication is missing its manifest byte receipt");
          }
          await recordRunEvent({
            type: "publication_created",
            publication_id: product.publication.publication.publication_id,
            run_id: currentRunId,
            manifest_sha256: publicationManifestSha,
            supersedes_publication_id: product.publication.publication.supersedes_publication_id,
            published_at: product.publication.publication.published_at,
          });
          currentPublicationId = product.publication.publication.publication_id;
          for (const artifact of product.manifest.artifacts) {
            await recordRunEvent({
              type: "artifact_produced",
              artifact: {
                artifact_id: artifact.artifact_id,
                name: artifact.relative_path.split("/").at(-1) ?? artifact.relative_path,
                role: artifact.role,
                relative_path: artifact.relative_path,
                media_type: artifact.media_type,
                size_bytes: artifact.size_bytes,
                sha256: artifact.sha256,
                generated_by_step_id: `dynamic:${submission.execution_proposal.requirement_id}`,
              },
            });
          }
          return {
            ok: true,
            status: "published",
            requirement_id: submission.execution_proposal.requirement_id,
            publication_id: product.publication.publication.publication_id,
            manifest_id: product.manifest.manifest_id,
            manifest_sha256: publicationManifestSha,
            operation_result_manifest_id: result.operationResult.result_manifest_id,
            tables: result.materialization.candidate.tables.map((table) => table.definition.table_id),
            relations: result.materialization.candidate.relations.map((relation) => relation.relation_id),
            artifacts: product.manifest.artifacts,
            source_acquisition_provenance: result.sourceAcquisitionProvenance,
            source_input_provenance: result.sourceInputProvenance,
            backend: result.receipt.execution_backend,
            security_boundary: false,
          };
          } finally {
            if (reservation !== null) await dynamicFamilyPreflight.complete(reservation);
            await executionLock.release();
          }
        },
      });
      const coreAssetTools = createCoreAssetTools({
        taskId,
        sourceAssetRegistry,
        sourceAssetsRoot: taskRoot,
      });
      const datasetTools = createDatasetExecutionTools({
        client: service,
        familyRegistry: createDefaultDatasetFamilyRegistry(),
        sourceAssetRegistry,
        taskId,
        taskRoot,
        runId: () => currentRunId,
        piSessionId: () => currentPiSessionId,
        discoveryLedger: () => toolHooks.discoveryLedger?.() ?? null,
        onDiagnostic: (diagnostic) => {
          console.info("tool.dataset_execution", diagnostic);
        },
        onPublication: async (data) => {
          const publication = data.publication;
          const manifestSha256 = publication.manifest_sha256 ?? data.manifest.sha256;
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
          currentPublicationId = publication.publication_id;
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
      const datasetRoutePreflightTool = createDatasetRoutePreflightTool();
      const datasetProfileScaffoldTool = createDatasetProfileScaffoldTool();
      const supplementaryArchiveTool = createSupplementaryArchiveExtractionTool({
        extract: async (pmcid, signal) => {
          const requirementId = `supplementary_${pmcid.toLowerCase()}`;
          const acquired = await acquisitionRuntime.acquire({
            schema_version: "1.0",
            request_id: `request_${randomUUID()}`,
            task_id: taskId,
            requirement_id: requirementId,
            binding_id: `archive_${pmcid.toLowerCase()}`,
            mode: "builtin",
            provider_id: EXTENDED_PROVIDER_IDS.europePmcSupplementary,
            recipe_id: null,
            recipe_version: null,
            parameters: { source: "europepmc_supplementary", accession: pmcid, entities: {} },
          }, signal);
          if (acquired.sourceAsset === null) {
            throw new Error(`Europe PMC did not return a supplementary ZIP for ${pmcid}`);
          }
          const extraction = await extractRegisteredZipMembers({
            taskId,
            taskRoot,
            archiveAssetId: acquired.sourceAsset.asset_id,
            sourceAssetRegistry,
          });
          const parsed = await parseRegisteredArchiveMembers({
            taskId,
            taskRoot,
            sourceAssetRegistry,
            members: extraction.members,
          });
          return { ...extraction, ...parsed };
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
        datasetRoutePreflightTool,
        datasetProfileScaffoldTool,
        supplementaryArchiveTool,
        dynamicFamilyPrepareTool,
        dynamicFamilyTool,
        ...coreAssetTools,
        ...importTools,
      ]);
      return {
        root: workspaceRoot,
        tools: [
          ...workspaceTools,
          ...bundle.tools,
          ...dynamicTools,
          ...datasetTools,
          datasetRoutePreflightTool,
          datasetProfileScaffoldTool,
          supplementaryArchiveTool,
          dynamicFamilyPrepareTool,
          dynamicFamilyTool,
          ...coreAssetTools,
          ...importTools,
        ],
        permissionBroker,
        setRunId: (nextRunId: string) => {
          if (currentRunId !== nextRunId) currentPublicationId = null;
          currentRunId = nextRunId;
          workspace.setRunId(nextRunId);
          permissionBroker.bindRun(nextRunId);
        },
        setPiSessionId: (piSessionId: string) => {
          currentPiSessionId = piSessionId;
        },
        getCurrentPublicationId: () => currentPublicationId,
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
