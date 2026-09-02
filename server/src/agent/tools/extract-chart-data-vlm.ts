/**
 * ``extract_chart_data_vlm`` tool (P5-08B, Python
 * ``skills/builtin/processing/extract_chart_data_vlm.py`` parity).
 *
 * Wraps the TS three-tier chart extraction (``server/src/processing/vlm/``):
 * L1 Qwen-VL → L2 PDF tables → L3 captions; all-tiers-failed is an error,
 * never an empty success. VLM credentials come from injected config.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  JsonValue,
  OperationResultManifest,
} from "@biomed/contracts";
import type { BioMedAgentTool } from "../contracts.js";
import {
  noopHooks,
  type ToolApprovalGate,
  type ToolHooks,
  type ToolServiceDeps,
} from "./tool-hooks.js";
import {
  createVlmTools,
  type VlmConfig,
  type VlmResult,
  type VlmToolHooks,
} from "../../processing/vlm/index.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import type { DatasetHILGate } from "../../dataset/review/hil-policy.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
import { errorResult } from "./result.js";

export const EXTRACT_CHART_DATA_VLM_TOOL_NAME = "extract_chart_data_vlm";

export interface ChartDataVlmToolDeps extends ToolServiceDeps {
  /** Agent-owned preparation root. Framework output remains authoritative. */
  workspaceRoot?: string;
  hooks?: ToolHooks;
  /** Static config (fixtures); ignored when ``resolveVlmConfig`` is provided. */
  vlmConfig?: Partial<VlmConfig>;
  /**
   * Live resolver consulted immediately before each governed extraction
   * request, so visual-model role changes apply without restart. The resolved
   * API key stays in memory and never enters tool results or events.
   */
  resolveVlmConfig?: () => Promise<VlmConfig>;
  /** Injectable HTTP client (fixture tests; default is the public policy client). */
  httpClient?: PublicHttpClient;
  /** Warning surface (Python ``run_ctx.add_warning`` parity). */
  onWarning?: (severity: string, message: string, source: string) => void;
  hilGate?: DatasetHILGate | null;
  approvalGate?: ToolApprovalGate | null;
  sourceAssetRegistry?: SourceAssetRegistry;
}

function expectString(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function currentTaskId(deps: Pick<ChartDataVlmToolDeps, "taskId">): string {
  const taskId = typeof deps.taskId === "function" ? deps.taskId() : deps.taskId;
  if (typeof taskId !== "string" || taskId.trim() === "") {
    throw new TypeError("formal VLM evidence registration requires taskId");
  }
  return taskId;
}

interface VlmFormalAssetSummary {
  asset_id: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
  operation_result_id: string;
  provenance: import("@biomed/contracts").CoreDerivedAssetProvenance;
}

/**
 * Deterministic sequential register-and-commit helper (registered-paper
 * parity, local — no import from the registered-paper module): writes the
 * output bytes, registers the derived asset with byte-verified receipt, and
 * records its committed OperationResult BEFORE the asset is used as a parent
 * for the next registration. Reuse this per stage; never batch-register
 * descendants before the parent result commits.
 */
async function registerVlmDerivedAsset(options: {
  taskId: string;
  taskRoot: string;
  sourceAssetRegistry: SourceAssetRegistry;
  bytes: Buffer;
  parentAssetIds: readonly string[];
  operationKind: import("@biomed/contracts").CoreDerivedAssetOperationKind;
  requirementId: string;
  parametersDigest: string;
  evidence: import("@biomed/contracts").JsonValue;
}): Promise<VlmFormalAssetSummary & { operationResult: OperationResultManifest }> {
  const outputDigest = createHash("sha256").update(options.bytes).digest("hex");
  const operationResultId = `result_vlm_${createHash("sha256")
    .update(JSON.stringify({
      requirement_id: options.requirementId,
      parent_asset_ids: options.parentAssetIds,
      parameter_digest: options.parametersDigest,
      output_digest: outputDigest,
    }))
    .digest("hex")
    .slice(0, 32)}`;
  const sourceId = `vlm_${options.operationKind}_${outputDigest.slice(0, 24)}`;
  const relativePath = `source_assets/vlm-evidence/${outputDigest}.json`;
  const destination = path.join(options.taskRoot, ...relativePath.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, options.bytes);
  const registered = await options.sourceAssetRegistry.registerDerived({
    sourceId,
    relativePath,
    role: "source",
    mediaType: "application/json",
    parentAssetIds: options.parentAssetIds,
    operationKind: options.operationKind,
    operationResultId,
    implementationId: "dataset_core.chart_vlm_evidence",
    implementationVersion: "1.0.0",
    parametersDigest: options.parametersDigest,
    evidence: options.evidence,
  });
  if (registered.receipt.sha256 !== outputDigest) {
    throw new Error("VLM evidence registration did not preserve output bytes");
  }
  const parentClosures = await Promise.all(options.parentAssetIds.map((assetId) =>
    options.sourceAssetRegistry.resolveFormalProvenanceClosure(assetId)));
  const upstreamResultIds = [...new Set(parentClosures.flatMap((closure) =>
    closure.flatMap((item) => "operation_result_id" in item ? [item.operation_result_id] : [])))];
  const implementationDigest = createHash("sha256").update("dataset_core.chart_vlm_evidence@1.0.0").digest("hex");
  const operationResult: OperationResultManifest = {
    schema_version: "1.0",
    result_manifest_id: operationResultId,
    task_id: options.taskId,
    run_id: "core",
    requirement_id: options.requirementId,
    operation_id: operationResultId,
    operation_kind: "derive",
    operation_attempt_id: `attempt_${operationResultId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: createHash("sha256").update(options.parentAssetIds.join("\u0000")).digest("hex"),
    parameter_digest: options.parametersDigest,
    implementation_digest: implementationDigest,
    output_digest: outputDigest,
    output_kind: "derived_evidence",
    output_summary: {
      stage: options.operationKind,
      asset_id: registered.receipt.asset_ref.asset_id,
      sha256: outputDigest,
    },
    output_files: [{
      relative_path: registered.receipt.relative_path,
      size_bytes: registered.receipt.size_bytes,
      sha256: registered.receipt.sha256,
    }],
    dependency_closure: {
      input_asset_ids: [...options.parentAssetIds],
      upstream_result_manifest_ids: upstreamResultIds,
      parameter_digest: options.parametersDigest,
      implementation_digest: implementationDigest,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${operationResultId}`,
      committed_at: registered.provenance.created_at,
    },
  };
  await options.sourceAssetRegistry.recordDerivedOperationResult(operationResult);
  return Object.freeze({
    asset_id: registered.receipt.asset_ref.asset_id,
    relative_path: registered.receipt.relative_path,
    sha256: outputDigest,
    size_bytes: registered.receipt.size_bytes,
    operation_result_id: operationResultId,
    provenance: registered.provenance,
    operationResult,
  });
}

async function mirrorPreparationOutputs(
  result: VlmResult,
  taskRoot: string,
  workspaceRoot: string | undefined,
): Promise<void> {
  if (result.status !== "ok" || workspaceRoot === undefined) return;
  const resolvedTaskRoot = path.resolve(taskRoot);
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  if (resolvedTaskRoot === resolvedWorkspaceRoot) return;
  for (const output of result.outputs) {
    const source = path.resolve(resolvedTaskRoot, output);
    const relative = path.relative(resolvedTaskRoot, source);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`VLM preparation output escaped the task root: ${output}`);
    }
    const destination = path.join(resolvedWorkspaceRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function formalizeVlmOutputs(options: {
  result: Extract<VlmResult, { status: "ok" }>;
  taskId: string;
  parentAssetId: string;
  taskRoot: string;
  sourceAssetRegistry: SourceAssetRegistry;
  hint: string;
}): Promise<{
  assets: readonly VlmFormalAssetSummary[];
  operationResult: OperationResultManifest | null;
}> {
  const readTaskFile = async (taskRelative: string): Promise<Buffer> => {
    const source = path.resolve(options.taskRoot, ...taskRelative.replaceAll("\\", "/").split("/"));
    const relative = path.relative(path.resolve(options.taskRoot), source);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`VLM output escaped the task root: ${taskRelative}`);
    }
    return readFile(source);
  };
  const identity = {
    model_name: options.result.model_name,
    model_version: options.result.model_version,
    prompt_digest: options.result.prompt_digest,
  };
  // Stage 1: the CANDIDATE carrier registers first, directly derived from the
  // exact Core source asset, and its OperationResult commits BEFORE anything
  // else derives from it. Without an accepted/corrected review this candidate
  // stays the only formal asset — it is never silently promoted as reviewed.
  const candidateBytes = await readTaskFile(options.result.candidate_manifest);
  const candidateParametersDigest = createHash("sha256")
    .update(JSON.stringify({
      stage: "candidate",
      hint: options.hint,
      ...identity,
    }))
    .digest("hex");
  const candidate = await registerVlmDerivedAsset({
    taskId: options.taskId,
    taskRoot: options.taskRoot,
    sourceAssetRegistry: options.sourceAssetRegistry,
    bytes: candidateBytes,
    parentAssetIds: [options.parentAssetId],
    operationKind: "vlm_extraction",
    requirementId: "vlm_extraction",
    parametersDigest: candidateParametersDigest,
    evidence: {
      source_asset_id: options.parentAssetId,
      output_kind: "candidate_manifest",
      output_sha256: createHash("sha256").update(candidateBytes).digest("hex"),
      candidate_manifest: options.result.candidate_manifest,
      ...identity,
      charts: JSON.parse(JSON.stringify(options.result.charts)) as JsonValue,
      manifest: JSON.parse(candidateBytes.toString("utf8")) as JsonValue,
    },
  });
  const review = options.result.review;
  if (review === undefined) {
    return Object.freeze({ assets: Object.freeze([candidate]), operationResult: null });
  }

  // Stage 2 (accepted/corrected only): a deterministic UTF-8 review-evidence
  // record binds the candidate carrier identity to the HIL review details;
  // its OperationResult commits before stage 3 derives from it.
  const reviewEvidenceRecord = {
    schema_version: "1.0",
    evidence_kind: "vlm_extraction_review",
    candidate_carrier: {
      asset_id: candidate.asset_id,
      sha256: candidate.sha256,
      relative_path: candidate.relative_path,
    },
    source_asset_id: options.parentAssetId,
    model_name: identity.model_name,
    model_version: identity.model_version,
    prompt_digest: identity.prompt_digest,
    review,
  };
  const reviewEvidenceBytes = Buffer.from(JSON.stringify(reviewEvidenceRecord), "utf8");
  const reviewEvidenceParametersDigest = createHash("sha256")
    .update(JSON.stringify({
      stage: "review_evidence",
      candidate_carrier_asset_id: candidate.asset_id,
      request_id: review.request_id,
      review_id: review.review_id,
      evidence_digest: review.evidence_digest,
      action: review.action,
    }))
    .digest("hex");
  const reviewEvidence = await registerVlmDerivedAsset({
    taskId: options.taskId,
    taskRoot: options.taskRoot,
    sourceAssetRegistry: options.sourceAssetRegistry,
    bytes: reviewEvidenceBytes,
    parentAssetIds: [candidate.asset_id],
    operationKind: "review_evidence",
    requirementId: "vlm_review_evidence",
    parametersDigest: reviewEvidenceParametersDigest,
    evidence: {
      candidate_carrier_asset_id: candidate.asset_id,
      source_asset_id: options.parentAssetId,
      review_id: review.review_id,
      request_id: review.request_id,
      review_action: review.action,
      review_evidence_digest: review.evidence_digest,
      output_sha256: createHash("sha256").update(reviewEvidenceBytes).digest("hex"),
    },
  });

  // Stage 3: the reviewed terminal manifest re-registers as vlm_extraction
  // with DIRECT parents [candidate, review_evidence]; its bytes are the
  // terminal reviewed projection written after HIL.
  const reviewedBytes = await readTaskFile(options.result.evidence_manifest);
  const reviewedParametersDigest = createHash("sha256")
    .update(JSON.stringify({
      stage: "reviewed",
      candidate_carrier_asset_id: candidate.asset_id,
      review_evidence_asset_id: reviewEvidence.asset_id,
      review_id: review.review_id,
      review_action: review.action,
      ...identity,
    }))
    .digest("hex");
  const reviewed = await registerVlmDerivedAsset({
    taskId: options.taskId,
    taskRoot: options.taskRoot,
    sourceAssetRegistry: options.sourceAssetRegistry,
    bytes: reviewedBytes,
    parentAssetIds: [candidate.asset_id, reviewEvidence.asset_id],
    operationKind: "vlm_extraction",
    requirementId: "vlm_extraction_reviewed",
    parametersDigest: reviewedParametersDigest,
    evidence: {
      candidate_carrier_asset_id: candidate.asset_id,
      review_evidence_asset_id: reviewEvidence.asset_id,
      review_id: review.review_id,
      review_request_id: review.request_id,
      review_action: review.action,
      review_evidence_digest: review.evidence_digest,
      source_asset_id: options.parentAssetId,
      output_sha256: createHash("sha256").update(reviewedBytes).digest("hex"),
      ...identity,
      manifest: JSON.parse(reviewedBytes.toString("utf8")) as JsonValue,
    },
  });
  return Object.freeze({
    assets: Object.freeze([reviewed] as VlmFormalAssetSummary[]),
    operationResult: reviewed.operationResult,
  });
}

/**
 * Create the chart-extraction tool. Returns a one-element array for symmetry
 * with ``createPdfTools`` and the P5-12 bundle flattener.
 */
export function createChartDataVlmTool(deps: ChartDataVlmToolDeps): BioMedAgentTool[] {
  const hooks = noopHooks(deps.hooks);
  const vlmHooks: VlmToolHooks = {
    onQueryStarted: hooks.onQueryStarted,
    onQuery: hooks.onQuery,
    onProgress: hooks.onProgress,
    onWarning: deps.onWarning,
  };
  let invocationTail = Promise.resolve();
  async function serializeInvocation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = invocationTail;
    let release = (): void => undefined;
    invocationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  const tool: BioMedAgentTool = {
    name: EXTRACT_CHART_DATA_VLM_TOOL_NAME,
    label: "Extract chart data via Qwen-VL",
    description:
      "Extract structured chart data (chart_type, axes, data_points, legend) " +
      "from a paper figure image or PDF using the configured visual model. " +
      "source_path is exploratory preparation-only material; source_asset_id is " +
      "the Core-registered input required for formal evidence registration. " +
      "Formal paper chart promotion must use extract_registered_paper_chart_evidence. " +
      "Accepts PNG/JPG/WEBP/GIF images (e.g., from capture_web_page) or PDF " +
      "files (e.g., from download_supplementary). For PDFs, extracts embedded " +
      "images and runs VLM on each (up to 10 per file). Writes chart_data.csv " +
      "and chart_data_points.csv to parsed/chart_data/. Falls back to PDF " +
      "tables (L2) then caption text (L3) if VLM fails. Returns an error if " +
      "all tiers fail. Concurrent calls are queued so each credential and data-review HIL " +
      "remains bound to exactly one invocation.",
    parameters: {
      type: "object",
      properties: {
        source_path: {
          type: "string",
          description:
            "Path to a PNG/JPG/WEBP/GIF image or a PDF file under the task " +
            "work directory (typically source_assets/figures/ for images or " +
            "source_assets/ for PDFs).",
        },
        source_asset_id: {
          type: "string",
          pattern: "^asset_[0-9a-f]{64}$",
          description:
            "Preferred formal input: a task-owned Core-acquired or Core-derived image/PDF asset. Successful extraction registers evidence outputs with Core provenance.",
        },
        hint: {
          type: "string",
          description:
            "Optional extraction hint (e.g., 'scatter plot, log scale'). " +
            "Appended to the VLM prompt to improve accuracy.",
        },
      },
      oneOf: [
        { required: ["source_path"] },
        { required: ["source_asset_id"] },
      ],
      additionalProperties: false,
    },
    execute: (argumentsValue, signal) => serializeInvocation(async () => {
      const record = argumentsValue as Record<string, unknown>;
      const sourceAssetId = expectString(record.source_asset_id, "source_asset_id", "");
      let sourcePath = expectString(record.source_path, "source_path", "");
      if (sourceAssetId !== "" && sourcePath !== "") {
        throw new TypeError("provide exactly one of source_asset_id or source_path");
      }
      if (sourceAssetId !== "") {
        if (!/^asset_[0-9a-f]{64}$/u.test(sourceAssetId) || deps.sourceAssetRegistry === undefined) {
          throw new TypeError("source_asset_id requires the task Core SourceAssetRegistry");
        }
        const resolved = await deps.sourceAssetRegistry.resolveFormalInput(sourceAssetId);
        for await (const chunk of resolved.content) void chunk;
        sourcePath = path.join(deps.taskRoot, ...resolved.registration_receipt.relative_path.split("/"));
      }
      if (sourcePath.trim() === "") {
        throw new TypeError("source_asset_id or source_path must be provided");
      }
      const hint = expectString(record.hint, "hint", "");
      if (deps.approvalGate === undefined || deps.approvalGate === null) {
        return {
          content: JSON.stringify({
            status: "error",
            code: "permission_gate_unavailable",
            retryable: false,
            error: "credential permission gate is required for DashScope VLM access",
            source_file: path.basename(sourcePath),
          }),
          isError: true,
        };
      }
      const permission = await deps.approvalGate.request(
        EXTRACT_CHART_DATA_VLM_TOOL_NAME,
        signal,
      );
      if (permission === "reject") {
        return {
          content: JSON.stringify({
            status: "error",
            code: "permission_denied",
            retryable: false,
            error: "credential permission was rejected for DashScope VLM access",
            source_file: path.basename(sourcePath),
          }),
          isError: true,
        };
      }
      let result: VlmResult;
      try {
        // Resolve the visual-extraction config immediately before the governed
        // request; failures surface as actionable tool errors.
        const tools = createVlmTools({
          taskRoot: deps.taskRoot,
          hooks: vlmHooks,
          vlmConfig: deps.resolveVlmConfig === undefined
            ? deps.vlmConfig
            : await deps.resolveVlmConfig(),
          httpClient: deps.httpClient,
          hilGate: deps.hilGate,
        });
        result = await tools.extractChartDataVlm(
          sourcePath,
          hint,
          signal,
          sourceAssetId !== "",
        );
        await mirrorPreparationOutputs(result, deps.taskRoot, deps.workspaceRoot);
        const formalEvidence = result.status === "ok" && sourceAssetId !== ""
          ? await formalizeVlmOutputs({
              result,
              taskId: currentTaskId(deps),
              parentAssetId: sourceAssetId,
              taskRoot: deps.taskRoot,
              sourceAssetRegistry: deps.sourceAssetRegistry!,
              hint,
            })
          : null;
        if (result.status === "ok") {
          const details = {
            ...result,
            formal_status: sourceAssetId === "" ? "preparation_only" : "core_registered",
            formal_evidence_assets: formalEvidence?.assets ?? [],
            operation_result: formalEvidence?.operationResult ?? null,
          };
          return { content: JSON.stringify(details, null, 2), details };
        }
      } catch (error) {
        const failure = errorResult(error);
        return {
          content: JSON.stringify({
            status: "error",
            source_file: path.basename(sourcePath),
            ...(failure.details as object),
          }),
          details: failure.details,
          isError: true,
        };
      }
      // A processor-returned {status:"error"} result is a tool error too —
      // never an unmarked success payload.
      if (result.status === "error") {
        return {
          content: JSON.stringify(result, null, 2),
          details: { status: "error", error: result.error },
          isError: true,
        };
      }
      return { content: JSON.stringify(result, null, 2), details: result };
    }),
  };

  return [tool];
}
