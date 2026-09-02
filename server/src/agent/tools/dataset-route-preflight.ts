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

const LITERATURE_EXPERIMENT_CHART_PROFILE = "literature_experiment_chart.release.v1";
const SCIENTIFIC_ASSERTION_PROFILE = "scientific_assertion.table.release.v1";

function sourceEntryRecord(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return value as Record<string, string>;
  const result: Record<string, string> = {};
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("registered_sources entries must be objects");
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.binding_id !== "string" || typeof entry.asset_id !== "string") {
      throw new TypeError("registered_sources entries require binding_id and asset_id");
    }
    if (Object.hasOwn(result, entry.binding_id)) {
      throw new TypeError(`registered_sources contains duplicate binding '${entry.binding_id}'`);
    }
    result[entry.binding_id] = entry.asset_id;
  }
  return result;
}

function acquisitionEntryRecord(value: unknown): Record<string, { provider_id: string; parameters: Record<string, unknown> }> {
  if (!Array.isArray(value)) {
    return value as Record<string, { provider_id: string; parameters: Record<string, unknown> }>;
  }
  const result: Record<string, { provider_id: string; parameters: Record<string, unknown> }> = {};
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("acquisition_requests entries must be objects");
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.binding_id !== "string"
      || typeof entry.provider_id !== "string"
      || entry.parameters === null
      || typeof entry.parameters !== "object"
      || Array.isArray(entry.parameters)
    ) {
      throw new TypeError("acquisition_requests entries require binding_id, provider_id, and parameters");
    }
    if (Object.hasOwn(result, entry.binding_id)) {
      throw new TypeError(`acquisition_requests contains duplicate binding '${entry.binding_id}'`);
    }
    result[entry.binding_id] = {
      provider_id: entry.provider_id,
      parameters: entry.parameters as Record<string, unknown>,
    };
  }
  return result;
}

function agentPrepareSubmission(
  submission: ReturnType<typeof buildCoreProfilePrepareSubmission>,
): Record<string, unknown> {
  const registeredSources = submission.registered_sources as Readonly<Record<string, string>>;
  const acquisitionRequests = submission.acquisition_requests as Readonly<Record<string, {
    readonly provider_id: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }>>;
  return {
    ...submission,
    registered_sources: Object.entries(registeredSources)
      .map(([binding_id, asset_id]) => ({ binding_id, asset_id })),
    acquisition_requests: Object.entries(acquisitionRequests)
      .map(([binding_id, request]) => ({ binding_id, ...request })),
  };
}

function productProfileGuidance(profileRef: string): {
  use_when: string;
  do_not_use_when: string;
} {
  if (profileRef === LITERATURE_EXPERIMENT_CHART_PROFILE) {
    return {
      use_when:
        "The requested product requires paper_records, experiment_records, activity_value_records, chart_series/chart_points, and supplementary_asset_records as one literature experiment closure.",
      do_not_use_when:
        "The product is only a normalized compound-assay-target activity matrix without paper experiment or supplementary-asset tables.",
    };
  }
  if (profileRef === SCIENTIFIC_ASSERTION_PROFILE) {
    return {
      use_when:
        "The requested product is a flat assertion table closure (one primary scientific assertion table plus optional supporting study records) with no charts and no VLM figure extraction.",
      do_not_use_when:
        "The request requires chart_series, chart_points, activity_value_records, or per-figure VLM extraction; use a chart product profile instead.",
    };
  }
  return {
    use_when:
      "The requested product is a normalized compound, assay, and target activity matrix with optional chart evidence.",
    do_not_use_when:
      "The request requires paper_records, experiment_records, or supplementary_asset_records; use literature_experiment_chart.release.v1 instead.",
  };
}

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
      "Dynamic Family cannot bind the binary archive directly. Call acquire_core_carrier with this provider once, then reference the returned provenance-bound extraction member asset ids as registered sources.",
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
          ...(source.required_entity_groups !== undefined
            ? {
                required_entities: source.required_entity_groups.map((group) =>
                  group.length === 1 ? group[0]! : [...group],
                ),
              }
            : {}),
        })),
      })),
    },
    dynamic: {
      route_status: "task_scoped_family_spec",
      use_when:
        "No static entry expresses the required semantic topology, but every input can close through a direct binding below or a prior task-owned Core acquisition asset.",
      next_tools: ["scaffold_dataset_profile", "prepare_dynamic_family_publication", "submit_dynamic_family_publication"],
      direct_bindings: directBindings,
      product_requirement_profiles: [...listCoreProductTopologyRequirements()]
        .sort((left, right) =>
          left.profile_ref === LITERATURE_EXPERIMENT_CHART_PROFILE
            ? -1
            : right.profile_ref === LITERATURE_EXPERIMENT_CHART_PROFILE
              ? 1
              : left.profile_ref.localeCompare(right.profile_ref))
        .map((requirements) => ({
        profile_ref: requirements.profile_ref,
        dataset_family: requirements.dataset_family,
        ...productProfileGuidance(requirements.profile_ref),
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
      "A literature experiment request requiring paper_records, experiment_records, activity_value_records, chart_series, chart_points, and supplementary_asset_records must use literature_experiment_chart.release.v1, not the legacy normalized bioactivity chart profile.",
      "Choose one route per family and row granularity. Do not send a task-scoped Dynamic FamilySpec to the static validator.",
    ],
  } as const;
}

export function createDatasetProfileScaffoldTool(): BioMedAgentTool {
  return {
    name: "scaffold_dataset_profile",
    label: "Scaffold Dataset Profile",
    description:
      "Generate the complete Core-owned FamilySpec, Projection, table definitions, relations, and transform output closure for one profile returned by inspect_dataset_execution_routes. Literature products requiring paper_records + experiment_records + activity_value_records + chart_series/points + supplementary_asset_records must select literature_experiment_chart.release.v1, never the legacy normalized bioactivity chart profile. With requirement/source/extraction facts, also returns the complete prepare submission; the Agent never authors profile topology, policy refs, or proposal refs. Read-only and side-effect-free. profile_ref is REQUIRED and must be one of the profile_ref values listed by inspect_dataset_execution_routes; an empty or omitted argument fails.",
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
              binding_kind: {
                type: "string",
                enum: ["transform_input", "provenance_only"],
                description: "transform_input (default when omitted) bytes are decoded into transform runtime inputs; provenance_only bytes are formally verified and published as provenance but never decoded. Every binding still needs registered_sources or acquisition_requests and at least one transform_input binding is required. Never infer from media_type.",
              },
              parameters: { type: "object" },
            },
            required: ["binding_id", "source", "input_requirement_ref", "parameters"],
            additionalProperties: false,
          },
        },
        registered_sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              binding_id: { type: "string" },
              asset_id: { type: "string", pattern: "^asset_[0-9a-f]{64}$" },
            },
            required: ["binding_id", "asset_id"],
            additionalProperties: false,
          },
        },
        acquisition_requests: {
          type: "array",
          items: {
            type: "object",
            properties: {
              binding_id: { type: "string" },
              provider_id: { type: "string" },
              parameters: { type: "object" },
            },
            required: ["binding_id", "provider_id", "parameters"],
            additionalProperties: false,
          },
        },
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
        const corePrepareSubmission = provided.length === 0
          ? null
          : buildCoreProfilePrepareSubmission({
              profileRef,
              requirementId: record.requirement_id as string,
              sourceBindings: record.source_bindings as Parameters<typeof buildCoreProfilePrepareSubmission>[0]["sourceBindings"],
              registeredSources: sourceEntryRecord(record.registered_sources),
              acquisitionRequests: acquisitionEntryRecord(record.acquisition_requests) as Parameters<typeof buildCoreProfilePrepareSubmission>[0]["acquisitionRequests"],
              transformSource: record.transform_source as string,
              transformInputRoles: record.transform_input_roles as Parameters<typeof buildCoreProfilePrepareSubmission>[0]["transformInputRoles"],
            });
        const prepareSubmission = corePrepareSubmission === null
          ? null
          : agentPrepareSubmission(corePrepareSubmission);
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
