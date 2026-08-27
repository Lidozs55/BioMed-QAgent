import { createHash } from "node:crypto";

import type {
  CoreAcquisitionRequest,
  DatasetBridgeResponse,
  DatasetBridgePublicationData,
  DatasetExecutionSpec,
} from "@biomed/contracts";
import { parseJsonTextStrict } from "@biomed/contracts";

import { saveExecutionContinuation } from "../../runtime/execution-continuation.js";
import { fixedBiomedicalAcquisitionParameters } from "../../dataset/acquisition/biomedical-providers.js";
import { CORE_ACQUISITION_PROVIDER_DESCRIPTORS } from "../../dataset/acquisition/provider-catalog.js";
import {
  createDefaultDatasetFamilyRegistry,
} from "../../dataset/families/index.js";
import type {
  BioMedAgentTool,
  BioMedToolExecutionContext,
  BioMedToolResult,
} from "../contracts.js";
import { parseDatasetExecutionSpec } from "../../dataset/contracts/index.js";
import { providerCarrierBinding } from "../../dataset/runtime/provider-bindings.js";
import type { DatasetCoreService } from "../../dataset/service/dataset-core.js";

const MAX_ID = 128;
const MAX_CONTENT = 4_096;
const STATIC_ROUTE_CONTEXT = Object.freeze({
  route_scope: "static_registered_family",
  dynamic_provider_availability_evaluated: false,
  route_guidance:
    "This result covers only the static registered-family route. It does not determine Dynamic Family provider availability; call inspect_dataset_execution_routes instead.",
});

export interface DatasetExecutionToolDiagnostic {
  taskId: string;
  runId: string;
  piSessionId: string;
  toolCallId: string;
  toolName: "validate_dataset_execution" | "execute_dataset_execution";
  requestId?: string;
  requirementId?: string;
  code: "ok" | string;
  durationMs: number;
}

export interface DatasetExecutionToolOptions {
  client: Pick<DatasetCoreService, "validate" | "execute"> &
    Partial<Pick<DatasetCoreService, "acquire">>;
  taskId: string;
  /** Task root on disk; the tool persists its invocation here so a
   * cross-restart resume can replay the exact same build deterministically
   * (no model reinterpretation of a synthetic prompt). */
  taskRoot: string;
  runId: () => string;
  piSessionId: () => string;
  onDiagnostic?: (diagnostic: DatasetExecutionToolDiagnostic) => void;
  onPublication?: (data: DatasetBridgePublicationData) => void | Promise<void>;
  now?: () => number;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function specArgument(value: Record<string, unknown>): DatasetExecutionSpec {
  const spec = value.spec;
  if (typeof spec === "string") {
    let parsed: unknown;
    try {
      parsed = parseJsonTextStrict(spec, { maxChars: MAX_CONTENT });
    } catch (error) {
      throw new TypeError(
        `spec must be a DatasetExecutionSpec object or a JSON-encoded string: ${(error as Error).message}`,
        { cause: error },
      );
    }
    return parseDatasetExecutionSpec(parsed);
  }
  return parseDatasetExecutionSpec(spec);
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
  spec: DatasetExecutionSpec,
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
  options: DatasetExecutionToolOptions,
  spec: DatasetExecutionSpec,
  binding: DatasetExecutionSpec["source_bindings"][number],
): CoreAcquisitionRequest {
  const requestDigest = createHash("sha256")
    .update(`${options.taskId}\u0000${options.runId()}\u0000${spec.requirement_id}\u0000${binding.binding_id}`)
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
    requirement_id: spec.requirement_id,
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
        "Stop static schema/required_fields probing. Use prepare_dynamic_family_publication for the requested exact multi-table topology, then pass its unchanged prepared_submission and preflight_receipt to submit_dynamic_family_publication.",
    };
  }
  return {};
}

function resultSummary(response: DatasetBridgeResponse): Record<string, unknown> {
  if (!response.ok) {
    return {
      ...STATIC_ROUTE_CONTEXT,
      code: response.error.code,
      request_id: response.request_id,
      message: response.error.message.slice(0, 500),
      retryable: response.error.retryable,
      ...dynamicFallback(response),
      ...(response.error.details.requirement_id === undefined ? {} : { requirement_id: response.error.details.requirement_id }),
      ...(response.error.details.publication_id === undefined ? {} : { publication_id: response.error.details.publication_id }),
      ...(response.error.details.reason_codes === undefined ? {} : {
        reason_codes: boundedStrings(response.error.details.reason_codes),
      }),
    };
  }
  if ("publication" in response.data) {
    return {
      code: "ok",
      request_id: response.request_id,
      requirement_id: response.data.requirement_id,
      publication_id: response.data.publication_id,
      manifest_id: response.data.manifest.manifest_id,
      artifact_count: response.data.artifacts.length,
      artifact_roles: boundedStrings(response.data.artifacts.map((artifact) => artifact.role)),
      registered_source_asset_count: response.data.registeredSourceAssetIds.length,
    };
  }
  return {
    ...STATIC_ROUTE_CONTEXT,
    code: "ok",
    request_id: response.request_id,
    valid: response.data.valid,
    reason_codes: boundedStrings(response.data.reason_codes),
    reasons: boundedStrings(response.data.reasons),
  };
}

function resultFor(response: DatasetBridgeResponse): BioMedToolResult {
  const details = response.ok
    ? { ...STATIC_ROUTE_CONTEXT, code: "ok", request_id: response.request_id, data: response.data }
    : {
        code: response.error.code,
        request_id: response.request_id,
        message: response.error.message,
        retryable: response.error.retryable,
        ...dynamicFallback(response),
        ...response.error.details,
        ...STATIC_ROUTE_CONTEXT,
      };
  return {
    content: JSON.stringify(resultSummary(response)),
    details,
    isError: !response.ok,
  };
}

function diagnostic(
  options: DatasetExecutionToolOptions,
  toolName: DatasetExecutionToolDiagnostic["toolName"],
  context: BioMedToolExecutionContext | undefined,
  started: number,
  response: DatasetBridgeResponse | undefined,
  code: string,
  requirementId?: string,
): void {
  options.onDiagnostic?.({
    taskId: options.taskId.slice(0, MAX_ID),
    runId: options.runId().slice(0, MAX_ID),
    piSessionId: options.piSessionId().slice(0, MAX_ID),
    toolCallId: (context?.toolCallId ?? "unknown").slice(0, MAX_ID),
    toolName,
    requestId: response?.request_id.slice(0, MAX_ID),
    requirementId: requirementId?.slice(0, MAX_ID),
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

async function capturePublication(
  options: DatasetExecutionToolOptions,
  response: DatasetBridgeResponse,
): Promise<void> {
  if (response.ok) {
    if ("publication" in response.data) {
      await options.onPublication?.(response.data);
    }
    return;
  }
}

function datasetExecutionSpecSchema(): object {
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
  const providerIds = unique([
    "registered_asset",
    ...CORE_ACQUISITION_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.providerId),
    ...definitions.flatMap((definition) => definition.sources
      .map((source) => providerCarrierBinding(definition.id, source.source, source.adapter_id)?.providerId ?? null)
      .filter((providerId): providerId is string => providerId !== null)),
  ]);
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
      provider_id: { anyOf: [{ type: "string", enum: providerIds }, { type: "null" }] },
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
      `Compact DatasetExecutionSpec contract. Choose one compatible family/schema/source combination; Core performs the authoritative compatibility check. Families: ${familyIds.join(", ")}. Schemas: ${schemaIds.join(", ")}. Row granularities: ${granularities.join(", ")}.`,
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      requirement_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
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
      "requirement_id",
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

export function createDatasetExecutionTools(
  options: DatasetExecutionToolOptions,
): BioMedAgentTool[] {
  const specSchema = {
    anyOf: [
      datasetExecutionSpecSchema(),
      { type: "string", minLength: 1 },
    ],
    description:
      "Frozen DatasetExecutionSpec. Pass it as a JSON object, or as a JSON-encoded string for compatibility with clients that serialize nested arguments.",
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
      name: "validate_dataset_execution",
      label: "Validate DatasetExecutionSpec",
      description:
        "Static registered-family route only: validate a DatasetExecutionSpec whose family, schema, source, and topology are an exact match from inspect_dataset_execution_routes. This does not test Dynamic Family provider availability.",
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
          diagnostic(
            options,
            "validate_dataset_execution",
            context,
            started,
            response,
            response.ok ? "ok" : response.error.code,
          );
          return resultFor(response);
        } catch (error) {
          diagnostic(options, "validate_dataset_execution", context, started, response, codeForCaught(error));
          return caught(error);
        }
      },
    },
    {
      name: "execute_dataset_execution",
      label: "Execute DatasetExecutionSpec",
      description:
        "Static registered-family route only: validate, execute, and publish an exact static match from inspect_dataset_execution_routes. For unsupported topology use the dynamic route only when the preflight reports closed inputs.",
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
        let requirementId: string | undefined;
        try {
          const args = object(value);
          const spec = specArgument(args);
          requirementId = spec.requirement_id;
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
            diagnostic(options, "execute_dataset_execution", context, started, response, validation.error.code, requirementId);
            return resultFor(validation);
          }
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
            await saveExecutionContinuation(options.taskRoot, {
              schema_version: 1,
              requirement_id: requirementId,
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
          await capturePublication(options, response);
          diagnostic(
            options,
            "execute_dataset_execution",
            context,
            started,
            response,
            response.ok ? "ok" : response.error.code,
            requirementId,
          );
          return resultFor(response);
        } catch (error) {
          diagnostic(options, "execute_dataset_execution", context, started, response, codeForCaught(error), requirementId);
          return caught(error);
        }
      },
    },
  ];
}
