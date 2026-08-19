import { createHash } from "node:crypto";

import type {
  BuildResult,
  CoreAcquisitionRequest,
  DatasetBridgeResponse,
  DatasetBuildSpec,
} from "@biomed/contracts";

import { saveBuildContinuation } from "../../runtime/build-continuation.js";
import {
  createDefaultDatasetFamilyRegistry,
  type DatasetFamilyDefinition,
} from "../../dataset/families/index.js";
import type {
  BioMedAgentTool,
  BioMedToolExecutionContext,
  BioMedToolResult,
} from "../contracts.js";
import { parseDatasetBuildSpec } from "../../dataset/contracts/index.js";
import type { DatasetCoreService } from "../../dataset/service/dataset-core.js";

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
  client: Pick<DatasetCoreService, "validate" | "execute"> &
    Partial<Pick<DatasetCoreService, "acquire">>;
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
  return parseDatasetBuildSpec(value.spec);
}

function mappingArgument(
  value: Record<string, unknown>,
  name: "source_files" | "mapping_files" | "metadata_files",
  optional = false,
): Record<string, string> {
  if (optional && value[name] === undefined) return {};
  const mapping = object(value[name]);
  if (Object.values(mapping).some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must map binding IDs to task-relative references`);
  }
  return mapping as Record<string, string>;
}

const REGISTERED_ASSET_ID = /^asset_[0-9a-f]{64}$/;

function registeredSourceAssetIds(sourceFiles: Record<string, string>): string[] {
  return [...new Set(Object.values(sourceFiles).filter((reference) => REGISTERED_ASSET_ID.test(reference)))].sort();
}

function assertKnownSourceBindings(
  spec: DatasetBuildSpec,
  sourceFiles: Record<string, string>,
): void {
  const bindingIds = new Set(spec.source_bindings.map((binding) => binding.binding_id));
  const unknown = Object.keys(sourceFiles).filter((bindingId) => !bindingIds.has(bindingId));
  if (unknown.length > 0) {
    throw new TypeError(`source_files contains unknown binding IDs: ${unknown.sort().join(", ")}`);
  }
}

function acquisitionRequest(
  options: DatasetBuildToolOptions,
  spec: DatasetBuildSpec,
  binding: DatasetBuildSpec["source_bindings"][number],
): CoreAcquisitionRequest {
  const requestDigest = createHash("sha256")
    .update(`${options.taskId}\u0000${options.runId()}\u0000${spec.build_id}\u0000${binding.binding_id}`)
    .digest("hex");
  return {
    schema_version: "1.0",
    request_id: `acq_${requestDigest}`,
    task_id: options.taskId,
    build_id: spec.build_id,
    binding_id: binding.binding_id,
    mode: binding.acquisition.mode,
    provider_id: binding.acquisition.provider_id,
    recipe_id: binding.acquisition.recipe_id,
    recipe_version: binding.acquisition.recipe_version,
    parameters: binding.parameters,
  };
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

function datasetFamilySpecSchema(definition: DatasetFamilyDefinition): object {
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
  const schemaVariants = definition.schemas.map((schema) => {
    const granularity = definition.granularities.find(
      (candidate) => candidate.id === schema.row_granularity,
    )!;
    const sourceBinding = {
      oneOf: definition.sources
        .filter((source) =>
          definition.runtime_id === "registered_multitable.runtime.v1" ||
          source.schema_refs.includes(schema.schema_id),
        )
        .map((source) => ({
          type: "object",
          properties: {
            schema_version: { type: "string", enum: ["1.0"] },
            binding_id: {
              type: "string",
              pattern: "^[A-Za-z0-9_-]{1,128}$",
              description: "Stable ID also used as the key in source_files and mapping_files.",
            },
            source: { type: "string", enum: [source.source] },
            acquisition,
            adapter_id: { type: "string", enum: [source.adapter_id] },
            accession: nullableString,
            parameters: source.parameter_schema,
          },
          required: [
            "binding_id",
            "source",
            "acquisition",
            "adapter_id",
            ...(source.parameters_required ? ["parameters"] : []),
          ],
          additionalProperties: false,
        })),
    } as const;
    return {
      type: "object",
      description:
        "Complete frozen DatasetBuildSpec. Execute mappings use the same binding_id keys.",
      properties: {
        schema_version: { type: "string", enum: ["1.0"] },
        build_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
        objective: { type: "string", minLength: 1 },
        dataset_family: { type: "string", enum: [definition.id] },
        row_granularity: { type: "string", enum: [schema.row_granularity] },
        entities: stringArrayRecord,
        cohort_filters: stringArrayRecord,
        required_fields: stringArray,
        schema_ref: { type: "string", enum: [schema.schema_id] },
        source_bindings: { type: "array", minItems: 1, items: sourceBinding },
        normalization_profile_ref: {
          anyOf: [
            { type: "string", enum: [...definition.normalization_profile_refs] },
            { type: "null" },
          ],
        },
        merge_strategy: { type: "string", enum: [...definition.merge_strategies] },
        validation_profile_ref: {
          type: "string",
          enum: [...definition.validation_profiles_by_schema[schema.schema_id]!],
        },
        output_format: { type: "string", enum: [...definition.output_formats] },
        target_entity_level: {
          anyOf: [
            ...(granularity.target_entity_level === null
              ? []
              : [{ type: "string", enum: [granularity.target_entity_level] }]),
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
  });
  return schemaVariants.length === 1
    ? schemaVariants[0]!
    : { oneOf: schemaVariants };
}

function datasetBuildSpecSchema(): object {
  const definitions = createDefaultDatasetFamilyRegistry().definitionsList();
  if (definitions.length === 1) {
    return datasetFamilySpecSchema(definitions[0]!);
  }
  return {
    oneOf: definitions.map((definition) => datasetFamilySpecSchema(definition)),
  };
}

export function createDatasetBuildTools(
  options: DatasetBuildToolOptions,
): BioMedAgentTool[] {
  const specSchema = datasetBuildSpecSchema();
  const mappingSchema = {
    type: "object",
    description:
      "Map each spec binding_id to asset.relative_path (a task-relative source path), or a strict asset_<64hex> ID whose task-owned source_assets directory contains exactly one file.",
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
        required: ["spec", "mapping_files"],
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
          const sourceFiles = mappingArgument(args, "source_files", true);
          assertKnownSourceBindings(spec, sourceFiles);
          for (const binding of spec.source_bindings) {
            if (sourceFiles[binding.binding_id] !== undefined) continue;
            if (options.client.acquire === undefined) {
              throw new Error(`Core acquisition is unavailable for binding '${binding.binding_id}'`);
            }
            const acquired = await options.client.acquire({
              ...identity,
              request: acquisitionRequest(options, spec, binding),
            });
            sourceFiles[binding.binding_id] = acquired.sourceAsset.asset_id;
          }
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
              registered_source_asset_ids: registeredSourceAssetIds(sourceFiles),
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
