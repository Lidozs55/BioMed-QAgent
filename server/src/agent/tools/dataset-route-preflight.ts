import {
  CORE_ACQUISITION_PROVIDER_DESCRIPTORS,
  DYNAMIC_ACQUISITION_PROVIDER_DESCRIPTORS,
  type CoreAcquisitionProviderDescriptor,
} from "../../dataset/acquisition/provider-catalog.js";
import { createDefaultDatasetFamilyRegistry } from "../../dataset/families/index.js";
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
      next_tools: ["prepare_dynamic_family_publication", "submit_dynamic_family_publication"],
      direct_bindings: directBindings,
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
