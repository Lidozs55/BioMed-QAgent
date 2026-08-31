/**
 * ``extract_chart_data_vlm`` tool (P5-08B, Python
 * ``skills/builtin/processing/extract_chart_data_vlm.py`` parity).
 *
 * Wraps the TS three-tier chart extraction (``server/src/processing/vlm/``):
 * L1 Qwen-VL → L2 PDF tables → L3 captions; all-tiers-failed is an error,
 * never an empty success. VLM credentials come from injected config.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
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
}) {
  const parametersDigest = createHash("sha256")
    .update(JSON.stringify({
      hint: options.hint,
      model_name: options.result.model_name,
      model_version: options.result.model_version,
      prompt_digest: options.result.prompt_digest,
    }))
    .digest("hex");
  const evidenceManifestFile = path.resolve(
    options.taskRoot,
    ...options.result.evidence_manifest.replaceAll("\\", "/").split("/"),
  );
  const evidenceOutputSha = createHash("sha256")
    .update(await readFile(evidenceManifestFile))
    .digest("hex");
  const operationResultId = `result_vlm_${createHash("sha256")
    .update(`${options.parentAssetId}\u0000${parametersDigest}\u0000${evidenceOutputSha}`)
    .digest("hex")
    .slice(0, 32)}`;
  const assets: Array<{
    asset_id: string;
    relative_path: string;
    sha256: string;
    size_bytes: number;
    operation_result_id: string;
    provenance: import("@biomed/contracts").CoreDerivedAssetProvenance;
  }> = [];
  for (const output of [options.result.evidence_manifest]) {
    const source = path.resolve(options.taskRoot, ...output.replaceAll("\\", "/").split("/"));
    const relative = path.relative(path.resolve(options.taskRoot), source);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`VLM output escaped the task root: ${output}`);
    }
    const bytes = await readFile(source);
    const manifest = JSON.parse(bytes.toString("utf8")) as import("@biomed/contracts").JsonValue;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const extension = path.extname(source).toLowerCase().replace(/[^.a-z0-9]/gu, "");
    const relativePath = `source_assets/vlm-evidence/${sha256}${extension}`;
    const destination = path.join(options.taskRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination, 1).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const registered = await options.sourceAssetRegistry.registerDerived({
      sourceId: `vlm_evidence_${sha256.slice(0, 24)}`,
      relativePath,
      role: "source",
      parentAssetIds: [options.parentAssetId],
      operationKind: "vlm_extraction",
      operationResultId,
      implementationId: "dataset_core.chart_vlm_evidence",
      implementationVersion: "1.0.0",
      parametersDigest,
      evidence: {
        source_asset_id: options.parentAssetId,
        output_kind: path.basename(output),
        output_sha256: sha256,
        model_name: options.result.model_name,
        model_version: options.result.model_version,
        prompt_digest: options.result.prompt_digest,
        charts: JSON.parse(JSON.stringify(options.result.charts)) as JsonValue,
        evidence_manifest: options.result.evidence_manifest,
        manifest,
      },
    });
    if (registered.receipt.sha256 !== sha256) {
      throw new Error("VLM evidence registration did not preserve output bytes");
    }
    assets.push({
      asset_id: registered.receipt.asset_ref.asset_id,
      relative_path: registered.receipt.relative_path,
      sha256,
      size_bytes: bytes.length,
      operation_result_id: operationResultId,
      provenance: registered.provenance,
    });
  }
  const upstreamResultIds = await options.sourceAssetRegistry
    .resolveFormalProvenanceClosure(options.parentAssetId)
    .then((items) => [...new Set(items.flatMap((item) =>
      "operation_result_id" in item ? [item.operation_result_id] : [],
    ))])
    .catch(() => [] as string[]);
  const operationResult: OperationResultManifest = {
    schema_version: "1.0",
    result_manifest_id: operationResultId,
    task_id: options.taskId,
    run_id: "core",
    requirement_id: "vlm_extraction",
    operation_id: operationResultId,
    operation_kind: "parse",
    operation_attempt_id: `attempt_${operationResultId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: options.parentAssetId.slice("asset_".length),
    parameter_digest: parametersDigest,
    implementation_digest: createHash("sha256").update("dataset_core.chart_vlm_evidence@1.0.0").digest("hex"),
    output_digest: createHash("sha256")
      .update(assets.map((asset) => asset.sha256).join("\u0000"))
      .digest("hex"),
    output_kind: "source_asset",
    output_summary: {
      model_name: options.result.model_name,
      model_version: options.result.model_version,
      prompt_digest: options.result.prompt_digest,
      evidence_assets: assets.map((asset) => ({
        asset_id: asset.asset_id,
        sha256: asset.sha256,
      })) as JsonValue,
    },
    output_files: assets.map((asset) => ({
      relative_path: asset.relative_path,
      size_bytes: asset.size_bytes,
      sha256: asset.sha256,
    })),
    dependency_closure: {
      input_asset_ids: [options.parentAssetId],
      upstream_result_manifest_ids: upstreamResultIds,
      parameter_digest: parametersDigest,
      implementation_digest: createHash("sha256").update("dataset_core.chart_vlm_evidence@1.0.0").digest("hex"),
    },
    commit: {
      state: "committed",
      commit_id: `commit_${operationResultId}`,
      committed_at: assets[0]?.provenance.created_at ?? new Date().toISOString(),
    },
  };
  await options.sourceAssetRegistry.recordDerivedOperationResult(operationResult);
  return Object.freeze({ assets: Object.freeze(assets), operationResult });
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
