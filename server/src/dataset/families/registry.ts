import type { JsonValue } from "@biomed/contracts";
import type { DatasetSchema, NormalizationProfile } from "../contracts/index.js";
import { parseAdapterParams } from "../contracts/index.js";
import {
  expressionNormalizationV1,
  getNormalizationProfile,
} from "../canonicalizer/index.js";
import { getAdapter } from "../adapters/adapters.js";
import {
  buildGeneExpressionSchema,
  buildProbeExpressionSchema,
} from "../schema/expression.js";
import { SchemaRegistry } from "../schema/store.js";
import { getValidationProfile } from "../validation/profile.js";

export interface DatasetFamilyGranularity {
  id: string;
  target_entity_level: string | null;
}

export interface DatasetFamilyValidationIssue {
  code: string;
  message: string;
}

export interface DatasetFamilySourceDefinition {
  source: string;
  adapter_id: string;
  schema_refs: readonly string[];
  parameters_required: boolean;
  parameter_schema: Record<string, unknown>;
  validateParameters: (
    parameters: Record<string, JsonValue>,
    normalizationProfile: NormalizationProfile,
  ) => DatasetFamilyValidationIssue[];
}

export interface DatasetFamilyDefinition {
  id: string;
  runtime_id: string;
  schemas: readonly DatasetSchema[];
  granularities: readonly DatasetFamilyGranularity[];
  validation_profiles_by_schema: Readonly<Record<string, readonly string[]>>;
  normalization_profile_refs: readonly string[];
  default_normalization_profile_ref: string;
  validation_profile_refs: readonly string[];
  merge_strategies: readonly string[];
  output_formats: readonly string[];
  sources: readonly DatasetFamilySourceDefinition[];
}

function sortedUnique(values: readonly string[], label: string): string[] {
  const unique = [...new Set(values)];
  if (unique.length !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return unique.sort();
}

const PRODUCTION_RUNTIME_BY_FAMILY: Readonly<Record<string, string>> = {
  gene_expression: "gene_expression.runtime.v1",
};

function validateDefinition(definition: DatasetFamilyDefinition): void {
  if (definition.id.trim() === "") throw new Error("dataset family id must not be blank");
  if (PRODUCTION_RUNTIME_BY_FAMILY[definition.id] !== definition.runtime_id) {
    throw new Error(
      `dataset family '${definition.id}' has no registered runtime implementation '${definition.runtime_id}'`,
    );
  }
  if (definition.schemas.length === 0) {
    throw new Error(`dataset family '${definition.id}' must declare at least one schema`);
  }
  const granularities = new Set(
    definition.granularities.map((granularity) => granularity.id),
  );
  for (const schema of definition.schemas) {
    if (schema.dataset_family !== definition.id) {
      throw new Error(
        `schema '${schema.schema_id}' belongs to family ${schema.dataset_family}, not ${definition.id}`,
      );
    }
    if (!granularities.has(schema.row_granularity)) {
      throw new Error(
        `schema '${schema.schema_id}' uses undeclared granularity '${schema.row_granularity}'`,
      );
    }
  }
  const schemaRefs = sortedUnique(
    definition.schemas.map((schema) => schema.schema_id),
    `${definition.id}.schemas`,
  );
  sortedUnique(definition.granularities.map((item) => item.id), `${definition.id}.granularities`);
  sortedUnique(definition.validation_profile_refs, `${definition.id}.validation_profile_refs`);
  sortedUnique(definition.merge_strategies, `${definition.id}.merge_strategies`);
  sortedUnique(definition.sources.map((source) => source.source), `${definition.id}.source ids`);
  sortedUnique(definition.sources.map((source) => source.adapter_id), `${definition.id}.adapters`);
  if (!definition.normalization_profile_refs.includes(definition.default_normalization_profile_ref)) {
    throw new Error(
      `default normalization profile '${definition.default_normalization_profile_ref}' is not declared`,
    );
  }
  for (const schemaRef of schemaRefs) {
    const profiles = definition.validation_profiles_by_schema[schemaRef];
    if (profiles === undefined || profiles.length === 0) {
      throw new Error(`schema '${schemaRef}' has no validation profile binding`);
    }
    for (const profileRef of profiles) {
      if (!definition.validation_profile_refs.includes(profileRef)) {
        throw new Error(
          `schema '${schemaRef}' references undeclared validation profile '${profileRef}'`,
        );
      }
    }
  }
  for (const configuredSchemaRef of Object.keys(definition.validation_profiles_by_schema)) {
    if (!schemaRefs.includes(configuredSchemaRef)) {
      throw new Error(`validation profile binding references unknown schema '${configuredSchemaRef}'`);
    }
  }
  for (const source of definition.sources) {
    if (typeof source.validateParameters !== "function") {
      throw new Error(
        `dataset family '${definition.id}' source '${source.source}' is missing parameter validator`,
      );
    }
    if (source.schema_refs.length === 0) {
      throw new Error(`source '${source.source}' must support at least one schema`);
    }
    for (const schemaRef of source.schema_refs) {
      if (!schemaRefs.includes(schemaRef)) {
        throw new Error(`source '${source.source}' references unknown schema '${schemaRef}'`);
      }
    }
    const adapter = getAdapter(source.adapter_id);
    if (adapter.source_database !== source.source) {
      throw new Error(
        `adapter '${source.adapter_id}' belongs to source ${adapter.source_database}, not ${source.source}`,
      );
    }
  }
  for (const profileRef of definition.normalization_profile_refs) {
    const profile = getNormalizationProfile(profileRef);
    if (profile.dataset_family !== definition.id) {
      throw new Error(
        `normalization profile '${profileRef}' belongs to family ${profile.dataset_family}, not ${definition.id}`,
      );
    }
  }
  for (const profileRef of definition.validation_profile_refs) {
    const profile = getValidationProfile(profileRef);
    if (profile.profile.dataset_family !== definition.id) {
      throw new Error(
        `validation profile '${profileRef}' belongs to family ${profile.profile.dataset_family}, not ${definition.id}`,
      );
    }
  }
}

export class DatasetFamilyRegistry {
  private readonly definitions = new Map<string, DatasetFamilyDefinition>();

  constructor(initial: readonly DatasetFamilyDefinition[] = []) {
    for (const definition of initial) this.register(definition);
  }

  register(definition: DatasetFamilyDefinition): void {
    validateDefinition(definition);
    if (this.definitions.has(definition.id)) {
      throw new Error(`dataset family '${definition.id}' is already registered`);
    }
    this.definitions.set(definition.id, definition);
  }

  get(familyId: string): DatasetFamilyDefinition {
    const definition = this.definitions.get(familyId);
    if (definition === undefined) {
      throw new Error(`dataset family '${familyId}' is not registered`);
    }
    return definition;
  }

  list(): string[] {
    return [...this.definitions.keys()].sort();
  }

  definitionsList(): DatasetFamilyDefinition[] {
    return this.list().map((familyId) => this.get(familyId));
  }

  schemaRegistry(): SchemaRegistry {
    return new SchemaRegistry(
      this.definitionsList().flatMap((definition) => [...definition.schemas]),
    );
  }

  validationProfileRefs(): string[] {
    return sortedUnique(
      this.definitionsList().flatMap((definition) => [...definition.validation_profile_refs]),
      "validation profile refs",
    );
  }
}

function emptyAdapterParameterSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "This adapter does not accept source-specific parameters.",
    properties: {},
    additionalProperties: false,
  };
}

function expressionAdapterParameterSchema(): Record<string, unknown> {
  const normalization = expressionNormalizationV1();
  return {
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
    required: [
      "format",
      "value_semantics",
      "value_scale",
      "expression_unit",
    ],
    additionalProperties: false,
  };
}

function noAdapterParameters(
  parameters: Record<string, JsonValue>,
): DatasetFamilyValidationIssue[] {
  return Object.keys(parameters).length === 0
    ? []
    : [{ code: "invalid_adapter_parameters", message: "adapter parameters are not applicable" }];
}

function validateGeoExpressionParameters(
  parameters: Record<string, JsonValue>,
  normalizationProfile: NormalizationProfile,
): DatasetFamilyValidationIssue[] {
  if (Object.keys(parameters).length === 0) {
    return [{
      code: "invalid_adapter_parameters",
      message: "geo.expression.v1 requires format/value_semantics/value_scale/expression_unit",
    }];
  }
  let parsed: ReturnType<typeof parseAdapterParams>;
  try {
    parsed = parseAdapterParams(parameters);
  } catch (error) {
    return [{
      code: "invalid_adapter_parameters",
      message: error instanceof Error ? error.message : String(error),
    }];
  }
  const issues: DatasetFamilyValidationIssue[] = [];
  if (!normalizationProfile.allowed_units.includes(parsed.expression_unit)) {
    issues.push({ code: "unknown_unit", message: `unknown expression unit '${parsed.expression_unit}'` });
  }
  if (!normalizationProfile.allowed_semantics.includes(parsed.value_semantics)) {
    issues.push({ code: "unknown_semantics", message: `unknown value semantics '${parsed.value_semantics}'` });
  }
  if (!normalizationProfile.allowed_value_scales.includes(parsed.value_scale)) {
    issues.push({ code: "unknown_scale", message: `unknown value scale '${parsed.value_scale}'` });
  }
  return issues;
}

export function geneExpressionFamilyDefinition(): DatasetFamilyDefinition {
  const emptyParameters = emptyAdapterParameterSchema();
  const geoParameters = expressionAdapterParameterSchema();
  return {
    id: "gene_expression",
    runtime_id: "gene_expression.runtime.v1",
    schemas: [buildGeneExpressionSchema(), buildProbeExpressionSchema()],
    granularities: [
      { id: "gene_sample_measurement", target_entity_level: "gene" },
      { id: "probe_sample_measurement", target_entity_level: "probe" },
    ],
    validation_profiles_by_schema: {
      "gene_expression.long.v1": ["gene_expression.release.v1"],
      "gene_expression.probe_long.v1": ["gene_expression.probe_release.v1"],
    },
    normalization_profile_refs: [expressionNormalizationV1().profile_id],
    default_normalization_profile_ref: expressionNormalizationV1().profile_id,
    validation_profile_refs: [
      "gene_expression.release.v1",
      "gene_expression.probe_release.v1",
    ],
    merge_strategies: ["append_by_canonical_row"],
    output_formats: ["csv"],
    sources: [
      {
        source: "gdc",
        adapter_id: "gdc.expression.v1",
        schema_refs: ["gene_expression.long.v1"],
        parameters_required: false,
        parameter_schema: emptyParameters,
        validateParameters: noAdapterParameters,
      },
      {
        source: "geo",
        adapter_id: "geo.expression.v1",
        schema_refs: [
          "gene_expression.long.v1",
          "gene_expression.probe_long.v1",
        ],
        parameters_required: true,
        parameter_schema: geoParameters,
        validateParameters: validateGeoExpressionParameters,
      },
      {
        source: "ucsc_xena",
        adapter_id: "xena.matrix.v1",
        schema_refs: ["gene_expression.long.v1"],
        parameters_required: false,
        parameter_schema: emptyParameters,
        validateParameters: noAdapterParameters,
      },
    ],
  };
}

export function createDefaultDatasetFamilyRegistry(): DatasetFamilyRegistry {
  return new DatasetFamilyRegistry([geneExpressionFamilyDefinition()]);
}
