import { createHash } from "node:crypto";

import type {
  BuildResult,
  CoreAcquisitionRequest,
  DatasetBridgeResponse,
  DatasetBridgeBuildData,
  DatasetBuildSpec,
} from "@biomed/contracts";
import { parseJsonTextStrict } from "@biomed/contracts";

import { saveBuildContinuation } from "../../runtime/build-continuation.js";
import { fixedBiomedicalAcquisitionParameters } from "../../dataset/acquisition/biomedical-providers.js";
import {
  createDefaultDatasetFamilyRegistry,
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
  onPublication?: (data: DatasetBridgeBuildData) => void | Promise<void>;
  now?: () => number;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function specArgument(value: Record<string, unknown>): DatasetBuildSpec {
  const spec = value.spec;
  if (typeof spec === "string") {
    let parsed: unknown;
    try {
      parsed = parseJsonTextStrict(spec, { maxChars: MAX_CONTENT });
    } catch (error) {
      throw new TypeError(
        `spec must be a DatasetBuildSpec object or a JSON-encoded string: ${(error as Error).message}`,
        { cause: error },
      );
    }
    return parseDatasetBuildSpec(parsed);
  }
  return parseDatasetBuildSpec(spec);
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

function assertKnownBindings(
  spec: DatasetBuildSpec,
  references: Record<string, string>,
  field: "source_files" | "mapping_files" | "metadata_files",
): void {
  const bindingIds = new Set(spec.source_bindings.map((binding) => binding.binding_id));
  const unknown = Object.keys(references).filter((bindingId) => !bindingIds.has(bindingId));
  if (unknown.length > 0) {
    throw new TypeError(`${field} contains unknown binding IDs: ${unknown.sort().join(", ")}`);
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
  const fixedParameters = fixedBiomedicalAcquisitionParameters({
    providerId: binding.acquisition.provider_id,
    source: binding.source,
    accession: binding.accession,
    entities: spec.entities,
    bindingParameters: binding.parameters,
  });
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
    parameters: fixedParameters ?? binding.parameters,
  };
}

function boundedStrings(values: readonly string[], limit = 32): string[] {
  return values.slice(0, limit).map((value) => value.slice(0, 200));
}

function dynamicFallback(response: DatasetBridgeResponse): Record<string, unknown> {
  if (
    !response.ok
    && response.error.retryable === false
    && /\btransform rejected:/i.test(response.error.message)
  ) {
    return {
      do_not_retry_static: true,
      recommended_next_action:
        "Stop static schema/required_fields probing. Use submit_dynamic_family_build with the requested exact multi-table topology, a TypeScript transform, and fixed Core acquisition_requests.",
    };
  }
  return {};
}

function resultSummary(response: DatasetBridgeResponse): Record<string, unknown> {
  if (!response.ok) {
    return {
      code: response.error.code,
      request_id: response.request_id,
      message: response.error.message.slice(0, 500),
      retryable: response.error.retryable,
      ...dynamicFallback(response),
      ...(response.error.details.build_id === undefined ? {} : { build_id: response.error.details.build_id }),
      ...(response.error.details.publication_id === undefined ? {} : { publication_id: response.error.details.publication_id }),
      ...(response.error.details.reason_codes === undefined ? {} : {
        reason_codes: boundedStrings(response.error.details.reason_codes),
      }),
      ...(response.error.details.build_result === undefined ? {} : {
        build_status: response.error.details.build_result.status,
        valid_row_count: response.error.details.build_result.valid_row_count,
        build_publication_id: response.error.details.build_result.publication_id,
        recommended_next_action: response.error.details.build_result.recommended_next_action.slice(0, 500),
      }),
    };
  }
  if ("build_result" in response.data) {
    const result = response.data.build_result;
    return {
      code: "ok",
      request_id: response.request_id,
      build_id: response.data.build_id,
      build_status: result.status,
      valid_row_count: result.valid_row_count,
      publication_id: response.data.publication_id,
      manifest_id: response.data.manifest?.manifest_id ?? null,
      artifact_count: response.data.artifacts.length,
      artifact_roles: boundedStrings(response.data.artifacts.map((artifact) => artifact.role)),
      registered_source_asset_count: response.data.registeredSourceAssetIds.length,
      recommended_next_action: result.recommended_next_action.slice(0, 500),
    };
  }
  return {
    code: "ok",
    request_id: response.request_id,
    valid: response.data.valid,
    reason_codes: boundedStrings(response.data.reason_codes),
    reasons: boundedStrings(response.data.reasons),
  };
}

function resultFor(response: DatasetBridgeResponse): BioMedToolResult {
  const details = response.ok
    ? { code: "ok", request_id: response.request_id, data: response.data }
    : {
        code: response.error.code,
        request_id: response.request_id,
        message: response.error.message,
        retryable: response.error.retryable,
        ...dynamicFallback(response),
        ...response.error.details,
      };
  return {
    content: JSON.stringify(resultSummary(response)),
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

function codeForCaught(error: unknown): string {
  if (
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, MAX_ID);
  }
  if (error instanceof TypeError) return "invalid_input";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "CoreAcquisitionError") return "acquisition_failed";
  return "bridge_unavailable";
}

function caught(error: unknown): BioMedToolResult {
  const code = codeForCaught(error);
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.slice(0, MAX_CONTENT)
      : "Dataset build tool failed";
  const retryable =
    error !== null && typeof error === "object" && "retryable" in error &&
    typeof error.retryable === "boolean"
      ? error.retryable
      : code === "bridge_unavailable";
  const errorDetails =
    error !== null && typeof error === "object" && "details" in error &&
    error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details
      : {};
  const details = { code, message, retryable, ...errorDetails };
  return {
    content: JSON.stringify(details),
    details,
    isError: true,
  };
}

async function captureBuildResult(
  options: DatasetBuildToolOptions,
  response: DatasetBridgeResponse,
): Promise<void> {
  if (response.ok) {
    if ("build_result" in response.data) {
      options.onBuildResult?.(response.data.build_result);
      if (response.data.publication !== undefined && response.data.publication !== null) {
        await options.onPublication?.(response.data);
      }
    }
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
  const definitions = createDefaultDatasetFamilyRegistry().definitionsList();
  const schemas = definitions.flatMap((definition) => definition.schemas);
  const sources = definitions.flatMap((definition) => definition.sources);
  const stringArray = { type: "array", items: { type: "string" } } as const;
  const stringArrayRecord = { type: "object", additionalProperties: stringArray } as const;
  const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
  const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();
  const familyIds = unique(definitions.map((definition) => definition.id));
  const schemaIds = unique(schemas.map((schema) => schema.schema_id));
  const granularities = unique(schemas.map((schema) => schema.row_granularity));
  const sourceIds = unique(sources.map((source) => source.source));
  const adapterIds = unique(sources.map((source) => source.adapter_id));
  const normalizationProfiles = unique(
    definitions.flatMap((definition) => [...definition.normalization_profile_refs]),
  );
  const validationProfiles = unique(
    definitions.flatMap((definition) => definition.validation_profile_refs),
  );
  const mergeStrategies = unique(
    definitions.flatMap((definition) => [...definition.merge_strategies]),
  );
  const outputFormats = unique(definitions.flatMap((definition) => [...definition.output_formats]));
  const parameters = {
    type: "object",
    description:
      "Provider parameters are checked by the selected Core adapter. Use the source skill or a Core rejection to correct incompatible fields.",
    additionalProperties: true,
  } as const;
  const acquisition = {
    type: "object",
    description:
      "For registered downloads use mode=builtin and the provider_id returned by the selected source capability.",
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      mode: { type: "string", enum: ["builtin", "workflow_recipe"] },
      provider_id: nullableString,
      recipe_id: nullableString,
      recipe_version: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    },
    required: ["mode"],
    additionalProperties: false,
  } as const;
  const sourceBinding = {
    type: "object",
    description:
      "One source binding. Compatibility between source, adapter, schema and parameters is enforced by Dataset Core.",
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      binding_id: {
        type: "string",
        pattern: "^[A-Za-z0-9_-]{1,128}$",
        description: "Stable ID also used as the key in source_files and mapping_files.",
      },
      source: { type: "string", enum: sourceIds },
      acquisition,
      adapter_id: { type: "string", enum: adapterIds },
      accession: nullableString,
      parameters,
    },
    required: ["binding_id", "source", "acquisition", "adapter_id"],
    additionalProperties: false,
  } as const;
  return {
    type: "object",
    description:
      `Compact DatasetBuildSpec contract. Choose one compatible family/schema/source combination; Core performs the authoritative compatibility check. Families: ${familyIds.join(", ")}. Schemas: ${schemaIds.join(", ")}. Row granularities: ${granularities.join(", ")}.`,
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      build_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
      objective: { type: "string", minLength: 1 },
      dataset_family: { type: "string", enum: familyIds },
      row_granularity: { type: "string", enum: granularities },
      entities: stringArrayRecord,
      cohort_filters: stringArrayRecord,
      required_fields: stringArray,
      schema_ref: { type: "string", enum: schemaIds },
      source_bindings: { type: "array", minItems: 1, items: sourceBinding },
      normalization_profile_ref: {
        anyOf: [{ type: "string", enum: normalizationProfiles }, { type: "null" }],
      },
      merge_strategy: { type: "string", enum: mergeStrategies },
      validation_profile_ref: { type: "string", enum: validationProfiles },
      output_format: { type: "string", enum: outputFormats },
      target_entity_level: nullableString,
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
  };
}

export function createDatasetBuildTools(
  options: DatasetBuildToolOptions,
): BioMedAgentTool[] {
  const specSchema = {
    anyOf: [
      datasetBuildSpecSchema(),
      { type: "string", minLength: 1 },
    ],
    description:
      "Frozen DatasetBuildSpec. Pass it as a JSON object, or as a JSON-encoded string for compatibility with clients that serialize nested arguments.",
  } as const;
  const sourceFilesSchema = {
    type: "object",
    description:
      "Optional map from spec binding_id to a task-owned asset reference. Omit a binding to use its registered Core acquisition provider. Values are asset.relative_path or strict asset_<64hex> IDs.",
    additionalProperties: { type: "string", minLength: 1 },
  } as const;
  const mappingFilesSchema = {
    type: "object",
    description:
      "Optional map from spec binding_id to a separately registered annotation/mapping asset. A gene-level schema fed by a probe-level source (e.g. GEO geo_probe) MUST declare a probe-to-gene annotation here, or the binding fails the gene-required coverage/residual gate and the run returns status no_data / reason no_primary_data. Omit unless the selected adapter requires one; do not repeat source_files here (see research_data_guidance expression_omics.md).",
    additionalProperties: { type: "string", minLength: 1 },
  } as const;
  const metadataFilesSchema = {
    type: "object",
    description:
      "Optional map from spec binding_id to an explicit metadata asset consumed by the selected adapter (for example repository sample metadata). Omit when not required.",
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
          diagnostic(options, "validate_dataset_build", context, started, response, codeForCaught(error));
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
          source_files: sourceFilesSchema,
          mapping_files: mappingFilesSchema,
          metadata_files: metadataFilesSchema,
        },
        required: ["spec"],
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
          assertKnownBindings(spec, sourceFiles, "source_files");
          const mappingFiles = mappingArgument(args, "mapping_files", true);
          assertKnownBindings(spec, mappingFiles, "mapping_files");
          const metadataFiles = mappingArgument(args, "metadata_files", true);
          assertKnownBindings(spec, metadataFiles, "metadata_files");
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
          await captureBuildResult(options, response);
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
          diagnostic(options, "execute_dataset_build", context, started, response, codeForCaught(error), buildId);
          return caught(error);
        }
      },
    },
  ];
}
