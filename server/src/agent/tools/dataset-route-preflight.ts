import {
  CORE_ACQUISITION_PROVIDER_DESCRIPTORS,
  DYNAMIC_ACQUISITION_PROVIDER_DESCRIPTORS,
  type CoreAcquisitionProviderDescriptor,
} from "../../dataset/acquisition/provider-catalog.js";
import { createDefaultDatasetFamilyRegistry } from "../../dataset/families/index.js";
import { listCoreProductTopologyRequirements } from "../../dataset/dynamic-family/product-requirement-registry.js";
import {
  buildCoreProfilePrepareSubmission,
  coreProductProfileScaffold,
} from "../../dataset/dynamic-family/profile-scaffold.js";
import type { BioMedAgentTool } from "../contracts.js";

type DirectDynamicProvider = {
  provider_id: string;
  source: string;
  input_kind: "utf8" | "gzip_utf8";
  input_hint: string;
  route_status: "dynamic_bindable";
};

type AcquisitionOnlyProvider = {
  provider_id: string;
  source: string;
  input_kind: "binary_archive";
  input_hint: string;
  route_status: "requires_formal_extraction";
  blocker: string;
};

function directProvider(
  descriptor: CoreAcquisitionProviderDescriptor,
): DirectDynamicProvider {
  if (descriptor.dynamicInput === "binary_archive") {
    throw new TypeError("binary archive provider is not directly bindable");
  }
  return {
    provider_id: descriptor.providerId,
    source: descriptor.source,
    input_kind: descriptor.dynamicInput,
    input_hint: descriptor.inputHint,
    route_status: "dynamic_bindable",
  };
}

function acquisitionOnlyProvider(
  descriptor: CoreAcquisitionProviderDescriptor,
): AcquisitionOnlyProvider {
  if (descriptor.dynamicInput !== "binary_archive") {
    throw new TypeError("text provider does not require formal extraction");
  }
  return {
    provider_id: descriptor.providerId,
    source: descriptor.source,
    input_kind: descriptor.dynamicInput,
    input_hint: descriptor.inputHint,
    route_status: "requires_formal_extraction",
    blocker:
      "Core can acquire the immutable binary carrier, but Dynamic Family cannot bind it directly. A provenance-bound UTF-8 extraction asset and supported selection path are required before submit.",
  };
}

/**
 * Current formal-route facts derived from the same registries used by static
 * validation and Core acquisition. This is capability inspection only: it
 * neither interprets user intent nor claims that a build is publishable.
 */
export function datasetRouteCapabilities() {
  const registry = createDefaultDatasetFamilyRegistry();
  const dynamicIds = new Set(
    DYNAMIC_ACQUISITION_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.providerId),
  );
  const directBindings = DYNAMIC_ACQUISITION_PROVIDER_DESCRIPTORS.map(directProvider);
  const acquisitionOnly = CORE_ACQUISITION_PROVIDER_DESCRIPTORS
    .filter((descriptor) => !dynamicIds.has(descriptor.providerId))
    .map(acquisitionOnlyProvider);

  return {
    schema_version: "1.0",
    static: {
      route_status: "registered_family_only",
      use_when:
        "One listed family, schema, row granularity, and source combination expresses the requested product.",
      next_tools: ["validate_dataset_execution", "execute_dataset_execution"],
      families: registry.definitionsList().map((family) => ({
        family_id: family.id,
        row_granularities: family.granularities.map((item) => item.id),
        schemas: family.schemas.map((schema) => schema.schema_id),
        sources: family.sources.map((source) => ({
          source: source.source,
          adapter_id: source.adapter_id,
          schemas: [...source.schema_refs],
        })),
      })),
    },
    dynamic: {
      route_status: "task_scoped_family_spec",
      use_when:
        "No static entry expresses the required semantic topology, but every input can close through a direct binding below or a prior task-owned Core acquisition asset.",
      next_tools: ["scaffold_dataset_profile", "prepare_dynamic_family_publication", "submit_dynamic_family_publication"],
      direct_bindings: directBindings,
      product_requirement_profiles: listCoreProductTopologyRequirements().map((requirements) => ({
        profile_ref: requirements.profile_ref,
        dataset_family: requirements.dataset_family,
        route_status: "core_owned_topology_only" as const,
        next_tool: "scaffold_dataset_profile" as const,
        tables: requirements.tables,
        relations: requirements.relations,
        blocker:
          "The Core profile proves required table/relation topology only; it does not prove source availability, extraction closure, validation success, or publication eligibility.",
      })),
    },
    core_acquisition_only: acquisitionOnly,
    rules: [
      "A source missing from the static families can still use Dynamic Family when it appears in dynamic.direct_bindings.",
      "Provider wiring proves only trusted acquisition/input decoding; it does not prove semantic family, projection, transform, source availability, validation, or publication closure.",
      "A provider in core_acquisition_only is not a direct Dynamic Family input. Resolve its stated extraction blocker or report the affected projection as blocked/NO_DATA.",
      "Choose one route per family and row granularity. Do not send a task-scoped Dynamic FamilySpec to the static validator.",
    ],
  } as const;
}

export function createDatasetProfileScaffoldTool(): BioMedAgentTool {
  return {
    name: "scaffold_dataset_profile",
    label: "Scaffold Dataset Profile",
    description:
      "Generate the complete Core-owned FamilySpec, Projection, table definitions, relations, and transform output closure for one profile returned by inspect_dataset_execution_routes. With requirement/source/extraction facts, also returns the complete prepare submission; the Agent never authors profile topology, policy refs, or proposal refs. Read-only and side-effect-free.",
    parameters: {
      type: "object",
      properties: {
        profile_ref: { type: "string", minLength: 1 },
        requirement_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$" },
        source_bindings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              binding_id: { type: "string" },
              source: { type: "string" },
              input_requirement_ref: { type: "string" },
              parameters: { type: "object" },
            },
            required: ["binding_id", "source", "input_requirement_ref", "parameters"],
            additionalProperties: false,
          },
        },
        registered_sources: { type: "object", additionalProperties: { type: "string", pattern: "^asset_[0-9a-f]{64}$" } },
        acquisition_requests: { type: "object", additionalProperties: { type: "object" } },
        transform_source: { type: "string", minLength: 1 },
        transform_input_roles: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              media_type: { type: "string" },
              constraint_ref: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["role", "media_type", "constraint_ref"],
            additionalProperties: false,
          },
        },
      },
      required: ["profile_ref"],
      additionalProperties: false,
    },
    async execute(value) {
      try {
        const profileRef = (value as { profile_ref?: unknown }).profile_ref;
        if (typeof profileRef !== "string" || profileRef.trim() !== profileRef || profileRef === "") {
          throw new TypeError("profile_ref must be a non-empty normalized string");
        }
        const scaffold = coreProductProfileScaffold(profileRef);
        const record = value as Record<string, unknown>;
        const submissionFields = [
          "requirement_id", "source_bindings", "registered_sources",
          "acquisition_requests", "transform_source", "transform_input_roles",
        ] as const;
        const provided = submissionFields.filter((field) => record[field] !== undefined);
        if (provided.length !== 0 && provided.length !== submissionFields.length) {
          throw new TypeError(`profile submission scaffold requires all fields: ${submissionFields.join(", ")}`);
        }
        const prepareSubmission = provided.length === 0
          ? null
          : buildCoreProfilePrepareSubmission({
              profileRef,
              requirementId: record.requirement_id as string,
              sourceBindings: record.source_bindings as Parameters<typeof buildCoreProfilePrepareSubmission>[0]["sourceBindings"],
              registeredSources: record.registered_sources as Parameters<typeof buildCoreProfilePrepareSubmission>[0]["registeredSources"],
              acquisitionRequests: record.acquisition_requests as Parameters<typeof buildCoreProfilePrepareSubmission>[0]["acquisitionRequests"],
              transformSource: record.transform_source as string,
              transformInputRoles: record.transform_input_roles as Parameters<typeof buildCoreProfilePrepareSubmission>[0]["transformInputRoles"],
            });
        const details = {
          ok: true,
          status: "scaffolded",
          scaffold,
          prepare_submission: prepareSubmission,
          next_action: prepareSubmission === null
            ? "supply_source_and_extraction_facts_to_scaffold"
            : "prepare_generated_submission",
        };
        return { content: JSON.stringify(details), details };
      } catch (error) {
        const details = {
          ok: false,
          error: {
            code: "profile_scaffold_rejected",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
            available_profiles: listCoreProductTopologyRequirements().map((item) => item.profile_ref),
          },
        };
        return { content: JSON.stringify(details), details, isError: true };
      }
    },
  };
}

export function createDatasetRoutePreflightTool(): BioMedAgentTool {
  return {
    name: "inspect_dataset_execution_routes",
    label: "Inspect Dataset Build Routes",
    description:
      "For every dataset-producing request, call before substantive acquisition. Returns current static family/source combinations, directly bindable Dynamic Family providers, and acquisition-only carriers with exact blockers. Read-only and side-effect-free; it does not validate a proposed build.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const details = datasetRouteCapabilities();
      return { content: JSON.stringify(details), details };
    },
  };
}
