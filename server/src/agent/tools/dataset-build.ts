import type {
  BuildResult,
  DatasetBridgeResponse,
  DatasetBuildSpec,
} from "@biomed/contracts";

import { saveBuildContinuation } from "../../runtime/build-continuation.js";
import { ADAPTER_REGISTRY } from "../../dataset/adapters/adapters.js";
import { expressionNormalizationV1 } from "../../dataset/canonicalizer/profiles.js";
import { createDefaultSchemaRegistry } from "../../dataset/schema/registry.js";
import type {
  BioMedAgentTool,
  BioMedToolExecutionContext,
  BioMedToolResult,
} from "../contracts.js";
import type { DatasetCoreService } from "../../dataset/service/dataset-core.js";
import { VALIDATION_PROFILE_REFS } from "../../dataset/validation/profile.js";

const MAX_ID = 128;
const MAX_CONTENT = 4_096;

export interface DatasetBuildToolDiagnostic {
  taskId: string;
  runId: string;
  piSessionId: string;
  toolCallId: string;
  toolName: "validate_dataset_build" | "execute_dataset_build";
  requestId?: string;
  buildId?: string;
  code: "ok" | string;
  durationMs: number;
}

export interface DatasetBuildToolOptions {
  client: Pick<DatasetCoreService, "validate" | "execute">;
  taskId: string;
  /** Task root on disk; the tool persists its invocation here so a
   * cross-restart resume can replay the exact same build deterministically
   * (no model reinterpretation of a synthetic prompt). */
  taskRoot: string;
  runId: () => string;
  piSessionId: () => string;
  onDiagnostic?: (diagnostic: DatasetBuildToolDiagnostic) => void;
  onBuildResult?: (result: BuildResult | null) => void;
  now?: () => number;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function specArgument(value: Record<string, unknown>): DatasetBuildSpec {
  return object(value.spec) as unknown as DatasetBuildSpec;
}

function mappingArgument(
  value: Record<string, unknown>,
  name: "source_files" | "mapping_files" | "metadata_files",
): Record<string, string> {
  const mapping = object(value[name]);
  if (Object.values(mapping).some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must map binding IDs to task-relative references`);
  }
  return mapping as Record<string, string>;
}

function resultFor(response: DatasetBridgeResponse): BioMedToolResult {
  const details = response.ok
    ? { code: "ok", request_id: response.request_id, data: response.data }
    : {
        code: response.error.code,
        request_id: response.request_id,
        message: response.error.message,
        ...response.error.details,
      };
  return {
    content: JSON.stringify(details).slice(0, MAX_CONTENT),
    details,
    isError: !response.ok,
  };
}

function diagnostic(
  options: DatasetBuildToolOptions,
  toolName: DatasetBuildToolDiagnostic["toolName"],
  context: BioMedToolExecutionContext | undefined,
  started: number,
  response: DatasetBridgeResponse | undefined,
  code: string,
  buildId?: string,
): void {
  options.onDiagnostic?.({
    taskId: options.taskId.slice(0, MAX_ID),
    runId: options.runId().slice(0, MAX_ID),
    piSessionId: options.piSessionId().slice(0, MAX_ID),
    toolCallId: (context?.toolCallId ?? "unknown").slice(0, MAX_ID),
    toolName,
    requestId: response?.request_id.slice(0, MAX_ID),
    buildId: buildId?.slice(0, MAX_ID),
    code: code.slice(0, MAX_ID),
    durationMs: Math.max(0, (options.now ?? Date.now)() - started),
  });
}

function caught(error: unknown): BioMedToolResult {
  const code =
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
      ? error.code.slice(0, MAX_ID)
      : "invalid_input";
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.slice(0, MAX_CONTENT)
      : "Dataset build tool failed";
  return {
    content: JSON.stringify({ code, message }),
    details: { code, message },
    isError: true,
  };
}

function captureBuildResult(
  options: DatasetBuildToolOptions,
  response: DatasetBridgeResponse,
): void {
  if (response.ok) {
    if ("build_result" in response.data) options.onBuildResult?.(response.data.build_result);
    return;
  }
  if (response.error.details.build_result !== undefined) {
    options.onBuildResult?.(response.error.details.build_result);
  }
}

function captureSpecRejected(
  options: DatasetBuildToolOptions,
  response: DatasetBridgeResponse,
  buildId: string,
): void {
  if (response.ok || response.error.code !== "spec_rejected") return;
  const reasonCodes = response.error.details.reason_codes ?? [];
  options.onBuildResult?.({
    status: "spec_rejected",
    valid_row_count: 0,
    successful_sources: [],
    rejected_sources: [],
    available_artifact_roles: [],
    publication_id: null,
    reason_codes: reasonCodes,
    user_summary: response.error.message,
    recommended_next_action: "Correct the DatasetBuildSpec and validate it again.",
    build_id: buildId,
  });
}

function datasetBuildSpecSchema(): object {
  const normalization = expressionNormalizationV1();
  const stringArray = {
    type: "array",
    items: { type: "string" },
  } as const;
  const stringArrayRecord = {
    type: "object",
    additionalProperties: stringArray,
  } as const;
  const nullableString = {
    anyOf: [{ type: "string" }, { type: "null" }],
  } as const;
  const acquisition = {
    type: "object",
    description:
      "How the immutable SourceAsset was acquired. For built-in downloads use mode=builtin and provider_id=<source>.files.v1; omit recipe fields.",
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      mode: { type: "string", enum: ["builtin", "workflow_recipe"] },
      provider_id: {
        ...nullableString,
        description: "Required for builtin mode, for example geo.files.v1.",
      },
      recipe_id: {
        ...nullableString,
        description: "Required only for workflow_recipe mode.",
      },
      recipe_version: {
        anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
        description: "Required only for workflow_recipe mode.",
      },
    },
    required: ["mode"],
    additionalProperties: false,
  } as const;
  const adapterParameters = {
    type: "object",
    description:
      "Must be empty for GDC/Xena. GEO requires every listed field; declare unknown value_scale honestly instead of guessing.",
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      format: {
        type: "string",
        enum: ["tximport_counts", "series_matrix", "supplementary_matrix"],
      },
      value_semantics: {
        type: "string",
        enum: [...normalization.allowed_semantics],
      },
      value_scale: {
        type: "string",
        enum: [...normalization.allowed_value_scales],
      },
      expression_unit: {
        type: "string",
        enum: [...normalization.allowed_units],
      },
      is_normalized: { type: "boolean" },
      platform_ids: {
        type: "array",
        items: { type: "string", pattern: "^GPL[0-9]+$" },
      },
      delimiter: {
        type: "string",
        description: "Use auto, or one character for supplementary_matrix only.",
      },
    },
    additionalProperties: false,
  } as const;
  const sourceBinding = {
    type: "object",
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      binding_id: {
        type: "string",
        pattern: "^[A-Za-z0-9_-]{1,128}$",
        description: "Stable ID also used as the key in source_files and mapping_files.",
      },
      source: {
        type: "string",
        enum: ["gdc", "geo", "ucsc_xena"],
      },
      acquisition,
      adapter_id: {
        type: "string",
        enum: Object.keys(ADAPTER_REGISTRY).sort(),
        description:
          "Use gdc.expression.v1 for gdc, geo.expression.v1 for geo, and xena.matrix.v1 for ucsc_xena.",
      },
      accession: nullableString,
      parameters: adapterParameters,
    },
    required: ["binding_id", "source", "acquisition", "adapter_id"],
    additionalProperties: false,
  } as const;
  return {
    type: "object",
    description:
      "Complete frozen DatasetBuildSpec. For each source binding, execute mappings must use the same binding_id key.",
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      build_id: {
        type: "string",
        pattern: "^[A-Za-z0-9_-]{1,128}$",
      },
      objective: { type: "string", minLength: 1 },
      dataset_family: { type: "string", enum: ["gene_expression"] },
      row_granularity: {
        type: "string",
        enum: ["gene_sample_measurement", "probe_sample_measurement"],
      },
      entities: stringArrayRecord,
      cohort_filters: stringArrayRecord,
      required_fields: stringArray,
      schema_ref: {
        type: "string",
        enum: createDefaultSchemaRegistry().list(),
        description:
          "Use gene_expression.long.v1 for gene rows or gene_expression.probe_long.v1 for probe rows.",
      },
      source_bindings: {
        type: "array",
        minItems: 1,
        items: sourceBinding,
      },
      normalization_profile_ref: {
        anyOf: [
          { type: "string", enum: [normalization.profile_id] },
          { type: "null" },
        ],
      },
      merge_strategy: {
        type: "string",
        enum: ["append_by_canonical_row"],
      },
      validation_profile_ref: {
        type: "string",
        enum: [...VALIDATION_PROFILE_REFS],
        description:
          "Use gene_expression.release.v1 for gene rows or gene_expression.probe_release.v1 for probe rows.",
      },
      output_format: { type: "string", enum: ["csv"] },
      target_entity_level: {
        anyOf: [
          { type: "string", enum: ["gene", "probe"] },
          { type: "null" },
        ],
      },
    },
    required: [
      "build_id",
      "objective",
      "dataset_family",
      "row_granularity",
      "schema_ref",
      "source_bindings",
      "validation_profile_ref",
    ],
    additionalProperties: false,
  } as const;
}

export function createDatasetBuildTools(
  options: DatasetBuildToolOptions,
): BioMedAgentTool[] {
  const specSchema = datasetBuildSpecSchema();
  const mappingSchema = {
    type: "object",
    description:
      "Map each spec binding_id to the corresponding downloaded asset.relative_path under this task output.",
    additionalProperties: { type: "string", minLength: 1 },
  } as const;
  return [
    {
      name: "validate_dataset_build",
      label: "Validate DatasetBuildSpec",
      description: "Validate the frozen DatasetBuildSpec through the trusted Dataset Core.",
      parameters: {
        type: "object",
        properties: { spec: specSchema },
        required: ["spec"],
        additionalProperties: false,
      },
      async execute(value, signal, context) {
        const started = (options.now ?? Date.now)();
        let response: DatasetBridgeResponse | undefined;
        try {
          response = await options.client.validate({
            taskId: options.taskId,
            runId: options.runId(),
            piSessionId: options.piSessionId(),
            toolCallId: context?.toolCallId ?? "unknown",
            spec: specArgument(object(value)),
            signal,
          });
          if (response.ok) options.onBuildResult?.(null);
          captureSpecRejected(options, response, specArgument(object(value)).build_id);
          diagnostic(
            options,
            "validate_dataset_build",
            context,
            started,
            response,
            response.ok ? "ok" : response.error.code,
          );
          return resultFor(response);
        } catch (error) {
          diagnostic(options, "validate_dataset_build", context, started, response, "bridge_unavailable");
          return caught(error);
        }
      },
    },
    {
      name: "execute_dataset_build",
      label: "Execute DatasetBuildSpec",
      description: "Validate, execute, and publish a dataset through the trusted Dataset Core.",
      parameters: {
        type: "object",
        properties: {
          spec: specSchema,
          source_files: mappingSchema,
          mapping_files: mappingSchema,
          metadata_files: mappingSchema,
        },
        required: ["spec", "source_files", "mapping_files"],
        additionalProperties: false,
      },
      async execute(value, signal, context) {
        const started = (options.now ?? Date.now)();
        let response: DatasetBridgeResponse | undefined;
        let buildId: string | undefined;
        try {
          const args = object(value);
          const spec = specArgument(args);
          buildId = spec.build_id;
          const identity = {
            taskId: options.taskId,
            runId: options.runId(),
            piSessionId: options.piSessionId(),
            toolCallId: context?.toolCallId ?? "unknown",
            spec,
            signal,
          };
          const validation = await options.client.validate(identity);
          if (!validation.ok) {
            response = validation;
            captureSpecRejected(options, validation, buildId);
            diagnostic(options, "execute_dataset_build", context, started, response, validation.error.code, buildId);
            return resultFor(validation);
          }
          options.onBuildResult?.(null);
          const sourceFiles = mappingArgument(args, "source_files");
          const mappingFiles = mappingArgument(args, "mapping_files");
          const metadataFiles = args.metadata_files === undefined
            ? {}
            : mappingArgument(args, "metadata_files");
          // The continuation record is the deterministic resume contract:
          // a later restart replays the exact same invocation (same spec and
          // asset references) onto the original run without asking the model.
          try {
            await saveBuildContinuation(options.taskRoot, {
              schema_version: 1,
              build_id: buildId,
              task_id: options.taskId,
              run_id: options.runId(),
              pi_session_id: options.piSessionId(),
              tool_call_id: context?.toolCallId ?? "unknown",
              spec,
              source_files: sourceFiles,
              mapping_files: mappingFiles,
              metadata_files: metadataFiles,
              created_at: new Date().toISOString(),
            });
          } catch (error) {
            // Persistence must not break the build itself; a missing record
            // only degrades cross-restart continuation to the legacy path.
            console.warn("tool.continuation_persist_failed", error);
          }
          response = await options.client.execute({
            ...identity,
            sourceFiles,
            mappingFiles,
            metadataFiles,
          });
          captureBuildResult(options, response);
          diagnostic(
            options,
            "execute_dataset_build",
            context,
            started,
            response,
            response.ok ? "ok" : response.error.code,
            buildId,
          );
          return resultFor(response);
        } catch (error) {
          diagnostic(options, "execute_dataset_build", context, started, response, "bridge_unavailable", buildId);
          return caught(error);
        }
      },
    },
  ];
}
