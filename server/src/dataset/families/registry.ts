import type { JsonValue } from "@biomed/contracts";
import type { DatasetSchema, MultiTableValidationPolicy, NormalizationProfile } from "../contracts/index.js";
import type { DatasetSchemaV2 } from "@biomed/contracts";
import { parseAdapterParams } from "../contracts/index.js";
import {
  expressionNormalizationV1,
  getNormalizationProfile,
} from "../canonicalizer/index.js";
import { getAdapter } from "../adapters/adapters.js";
import { isRegisteredTableAdapterId } from "../adapters/registered/index.js";
import {
  literatureEvidenceAdapterRegistrations,
  literatureEvidenceTables,
  LITERATURE_EVIDENCE_FAMILY_ID,
} from "./literature-evidence/index.js";
import {
  createTargetEvidenceRegisteredTableRegistry,
  targetEvidenceSchemas,
  TARGET_EVIDENCE_FAMILY_ID,
  targetEvidenceTableDefinitions,
  targetEvidenceValidationPolicy,
} from "./target-evidence/index.js";
import {
  buildVariantEvidenceTables,
  createVariantEvidenceRegisteredTableRegistry,
  VARIANT_EVIDENCE_FAMILY_ID,
} from "./variant-evidence/index.js";
import {
  buildProteinStructureTables,
  createProteinStructureRegisteredTableRegistry,
  PROTEIN_STRUCTURE_FAMILY_ID,
} from "./protein-structure/index.js";
import {
  bioactivityCompoundCrosswalkSchema,
  bioactivityTableEntries,
  bioactivityValidationPolicy,
  createBioactivityRegisteredTableRegistry,
  BIOACTIVITY_FAMILY_ID,
} from "./bioactivity-measurement/index.js";
import {
  createGutMicrobiomeRegisteredTableRegistry,
  GUT_MICROBIOME_TAXON_TSV_ADAPTER_ID,
  gutMicrobiomeSchemas,
  gutMicrobiomeTableDefinitions,
  GUT_MICROBIOME_FAMILY_ID,
} from "./gut-microbiome/index.js";
import {
  createInheritedDiseaseEvidenceRegisteredTableRegistry,
  inheritedDiseaseEvidenceSchemas,
  INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
  inheritedDiseaseEvidenceTables,
  inheritedDiseaseEvidenceValidationPolicy,
} from "./inherited-disease-evidence/index.js";
import {
  buildGeneExpressionSchema,
  buildGeneExpressionSchemaV2,
  buildProbeExpressionSchema,
  buildProbeExpressionSchemaV2,
} from "../schema/expression.js";
import { SchemaRegistry } from "../schema/store.js";
import { getValidationProfile } from "../validation/profile.js";
import { providerCarrierBinding } from "../runtime/provider-bindings.js";

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
  /** Registered-table families bind one source asset to one canonical table parser. */
  table_id?: string;
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
  schemas: readonly (DatasetSchema | DatasetSchemaV2)[];
  granularities: readonly DatasetFamilyGranularity[];
  validation_profiles_by_schema: Readonly<Record<string, readonly string[]>>;
  normalization_profile_refs: readonly string[];
  default_normalization_profile_ref: string;
  validation_profile_refs: readonly string[];
  merge_strategies: readonly string[];
  output_formats: readonly string[];
  sources: readonly DatasetFamilySourceDefinition[];
  multitable_validation_policy?: MultiTableValidationPolicy;
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
  literature_evidence: "registered_multitable.runtime.v1",
  inherited_disease_gene_evidence: "registered_multitable.runtime.v1",
  target_evidence: "registered_multitable.runtime.v1",
  variant_evidence: "registered_multitable.runtime.v1",
  protein_structure: "registered_multitable.runtime.v1",
  bioactivity_measurement: "registered_multitable.runtime.v1",
  gut_microbiome: "registered_multitable.runtime.v1",
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
  sortedUnique(
    definition.sources.map((source) => `${source.source}\u0000${source.adapter_id}`),
    `${definition.id}.source ids`,
  );
  sortedUnique(
    definition.sources.map((source) => `${source.source}\u0000${source.adapter_id}`),
    `${definition.id}.adapters`,
  );
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
    if (source.table_id !== undefined && source.table_id.trim() === "") {
      throw new Error(`dataset family '${definition.id}' source table_id must not be blank`);
    }
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
    if (isRegisteredTableAdapterId(source.adapter_id) || providerCarrierBinding(definition.id, source.source, source.adapter_id) !== null) continue;
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

export function registeredTableSchemasById(
  definition: Pick<DatasetFamilyDefinition, "id" | "schemas" | "sources">,
): ReadonlyMap<string, DatasetSchemaV2> {
  const schemas = new Map<string, DatasetSchemaV2>();
  for (const source of definition.sources) {
    if (source.table_id === undefined) continue;
    if (source.schema_refs.length !== 1) {
      throw new Error(
        `registered table '${definition.id}/${source.table_id}' must reference exactly one schema`,
      );
    }
    const schemaRef = source.schema_refs[0]!;
    const schema = definition.schemas.find(
      (candidate): candidate is DatasetSchemaV2 =>
        candidate.schema_id === schemaRef && candidate.schema_version === "2.0",
    );
    if (schema === undefined) {
      throw new Error(
        `registered table '${definition.id}/${source.table_id}' requires Schema 2.0 '${schemaRef}'`,
      );
    }
    const existing = schemas.get(source.table_id);
    if (existing !== undefined && existing.schema_id !== schema.schema_id) {
      throw new Error(
        `registered table '${definition.id}/${source.table_id}' has conflicting schemas`,
      );
    }
    schemas.set(source.table_id, schema);
  }
  return schemas;
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
    schemas: [
      buildGeneExpressionSchema(),
      buildProbeExpressionSchema(),
      buildGeneExpressionSchemaV2(),
      buildProbeExpressionSchemaV2(),
    ],
    granularities: [
      { id: "gene_sample_measurement", target_entity_level: "gene" },
      { id: "probe_sample_measurement", target_entity_level: "probe" },
    ],
    validation_profiles_by_schema: {
      "gene_expression.long.v1": ["gene_expression.release.v1"],
      "gene_expression.probe_long.v1": ["gene_expression.probe_release.v1"],
      "gene_expression.long.v2": ["gene_expression.release.v1"],
      "gene_expression.probe_long.v2": ["gene_expression.probe_release.v1"],
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
        schema_refs: ["gene_expression.long.v1", "gene_expression.long.v2"],
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
          "gene_expression.long.v2",
          "gene_expression.probe_long.v2",
        ],
        parameters_required: true,
        parameter_schema: geoParameters,
        validateParameters: validateGeoExpressionParameters,
      },
      {
        source: "ucsc_xena",
        adapter_id: "xena.matrix.v1",
        schema_refs: ["gene_expression.long.v1", "gene_expression.long.v2"],
        parameters_required: false,
        parameter_schema: emptyParameters,
        validateParameters: noAdapterParameters,
      },
    ],
  };
}

function registeredSource(options: {
  source: string;
  tableId: string;
  adapterId: string;
  schemaRef: string;
}): DatasetFamilySourceDefinition {
  return {
    source: options.source,
    table_id: options.tableId,
    adapter_id: options.adapterId,
    schema_refs: [options.schemaRef],
    parameters_required: false,
    parameter_schema: emptyAdapterParameterSchema(),
    validateParameters: noAdapterParameters,
  };
}

function registeredFamily(options: {
  id: string;
  schemas: readonly (DatasetSchema | DatasetSchemaV2)[];
  profileRef: string;
  sources: readonly DatasetFamilySourceDefinition[];
  validationPolicy?: MultiTableValidationPolicy;
}): DatasetFamilyDefinition {
  return {
    id: options.id,
    runtime_id: "registered_multitable.runtime.v1",
    schemas: options.schemas,
    granularities: [...new Map(options.schemas.map((schema) => [schema.row_granularity, {
      id: schema.row_granularity,
      target_entity_level: null,
    }])).values()],
    validation_profiles_by_schema: Object.fromEntries(
      options.schemas.map((schema) => [schema.schema_id, [options.profileRef]]),
    ),
    normalization_profile_refs: [`${options.id}.registered.v1`],
    default_normalization_profile_ref: `${options.id}.registered.v1`,
    validation_profile_refs: [options.profileRef],
    merge_strategies: ["registered_multitable_identity"],
    output_formats: ["csv"],
    sources: options.sources,
    multitable_validation_policy: options.validationPolicy ?? {
      token_preservation_rules: [],
      profile_relation_missing_policies: {},
    },
  };
}

export function literatureEvidenceFamilyDefinition(): DatasetFamilyDefinition {
  const registrations = literatureEvidenceAdapterRegistrations;
  return registeredFamily({
    id: LITERATURE_EVIDENCE_FAMILY_ID,
    schemas: literatureEvidenceTables.map((entry) => entry.schema),
    profileRef: "literature_evidence.release.v1",
    sources: [{
      source: "pubmed",
      adapter_id: "literature.bioc_xml.v1",
      schema_refs: [literatureEvidenceTables[0]!.schema.schema_id],
      parameters_required: false,
      parameter_schema: emptyAdapterParameterSchema(),
      validateParameters: noAdapterParameters,
    }, ...registrations.map((registration, index) => registeredSource({
      source: `registered_literature_${literatureEvidenceTables[index]!.definition.table_id}`,
      tableId: literatureEvidenceTables[index]!.definition.table_id,
      adapterId: registration.parser.adapter_id,
      schemaRef: registration.schema.schema_id,
    }))],
  });
}

export function targetEvidenceFamilyDefinition(): DatasetFamilyDefinition {
  const definitions = targetEvidenceTableDefinitions();
  const registrations = createTargetEvidenceRegisteredTableRegistry().entries();
  return registeredFamily({
    id: TARGET_EVIDENCE_FAMILY_ID,
    schemas: targetEvidenceSchemas,
    profileRef: "target_evidence.release.v1",
    validationPolicy: targetEvidenceValidationPolicy(),
    sources: [...(["uniprot", "ncbi_clinvar", "clinicaltrials_gov"] as const).map((source) => ({
      source,
      adapter_id: source === "uniprot" ? "target.evidence.uniprot.v1" : source === "ncbi_clinvar" ? "target.evidence.clinvar.v1" : "target.evidence.trials.v1",
      schema_refs: [targetEvidenceSchemas[0]!.schema_id],
      parameters_required: false,
      parameter_schema: emptyAdapterParameterSchema(),
      validateParameters: noAdapterParameters,
    })), ...registrations.map((registration) => {
      const index = targetEvidenceSchemas.findIndex((schema) => schema.schema_id === registration.schema.schema_id);
      return registeredSource({
        source: `registered_target_${definitions[index]!.table_id}`,
        tableId: definitions[index]!.table_id,
        adapterId: registration.parser.adapter_id,
        schemaRef: registration.schema.schema_id,
      });
    })],
  });
}

export function variantEvidenceFamilyDefinition(): DatasetFamilyDefinition {
  const tables = buildVariantEvidenceTables();
  const definitions = [tables.variantTable, tables.evidenceTable, tables.sourceTable];
  const registrations = createVariantEvidenceRegisteredTableRegistry().entries();
  return registeredFamily({
    id: VARIANT_EVIDENCE_FAMILY_ID,
    schemas: [tables.variant, tables.evidence, tables.source],
    profileRef: "variant_evidence.release.v1",
    sources: registrations.map((registration) => {
      const index = [tables.variant, tables.evidence, tables.source].findIndex((schema) => schema.schema_id === registration.schema.schema_id);
      return registeredSource({ source: `registered_variant_${definitions[index]!.table_id}`, tableId: definitions[index]!.table_id, adapterId: registration.parser.adapter_id, schemaRef: registration.schema.schema_id });
    }),
  });
}

export function proteinStructureFamilyDefinition(): DatasetFamilyDefinition {
  const tables = buildProteinStructureTables();
  const entries = [
    { tableId: "structures", schema: tables.structure },
    { tableId: "chains", schema: tables.chain },
    { tableId: "ligands", schema: tables.ligand },
    { tableId: "sources", schema: tables.source },
  ];
  const registrations = createProteinStructureRegisteredTableRegistry().entries();
  // Multiple registered parsers may share one schema (e.g. JSON + XLSX media
  // variants for the same table). The family dispatch surface keeps one
  // canonical source per schema; the extra parser remains promoted in the
  // registered-table registry for the browser recipe catalog and carrier path.
  const seenSchemas = new Set<string>();
  const canonicalRegistrations = registrations.filter((registration) => {
    if (seenSchemas.has(registration.schema.schema_id)) return false;
    seenSchemas.add(registration.schema.schema_id);
    return true;
  });
  return registeredFamily({
    id: PROTEIN_STRUCTURE_FAMILY_ID,
    schemas: entries.map((entry) => entry.schema),
    profileRef: "protein_structure.release.v1",
    sources: [{
      source: "pdb",
      adapter_id: "protein.structure.carrier.v1",
      schema_refs: [tables.structure.schema_id],
      parameters_required: false,
      parameter_schema: emptyAdapterParameterSchema(),
      validateParameters: noAdapterParameters,
    }, ...canonicalRegistrations.map((registration) => {
      const entry = entries.find((item) => item.schema.schema_id === registration.schema.schema_id)!;
      return registeredSource({ source: `registered_structure_${entry.tableId}`, tableId: entry.tableId, adapterId: registration.parser.adapter_id, schemaRef: registration.schema.schema_id });
    })],
  });
}

export function gutMicrobiomeFamilyDefinition(): DatasetFamilyDefinition {
  const registrations = createGutMicrobiomeRegisteredTableRegistry().entries();
  const definitions = gutMicrobiomeTableDefinitions();
  const tableBySchema = new Map(definitions.map((definition) => [definition.schema_ref, definition.table_id]));
  const formalRegistrations = registrations.filter(
    (registration) => registration.parser.adapter_id !== GUT_MICROBIOME_TAXON_TSV_ADAPTER_ID,
  );
  const providerSources = [
    { source: "mgnify", adapterId: "registered_gut_microbiome_study_json", schemaRef: "gut_microbiome.study.v1" },
    { source: "mgnify", adapterId: "registered_gut_microbiome_taxon_long_tsv", schemaRef: "gut_microbiome.taxon_records.v1" },
    { source: "mgnify", adapterId: "registered_gut_microbiome_taxon_json", schemaRef: "gut_microbiome.taxon_records.v1" },
    { source: "mgnify", adapterId: "registered_gut_microbiome_differential_abundance_xlsx", schemaRef: "gut_microbiome.differential_abundance.v1" },
    { source: "ncbi_taxonomy", adapterId: "gut_microbiome.ncbi_taxonomy_esearch_json.v1", schemaRef: "gut_microbiome.taxon_records.v1" },
    { source: "ncbi_taxonomy", adapterId: "gut_microbiome.ncbi_taxonomy_efetch_xml.v1", schemaRef: "gut_microbiome.taxon_records.v1" },
    { source: "gmrepo", adapterId: "gut_microbiome.gmrepo_associated_species_json.v1", schemaRef: "gut_microbiome.reference_prevalence.v1" },
  ] as const;
  return registeredFamily({
    id: GUT_MICROBIOME_FAMILY_ID,
    schemas: gutMicrobiomeSchemas,
    profileRef: "gut_microbiome.release.v1",
    sources: [
      ...providerSources.map(({ source, adapterId, schemaRef }) => ({
        source,
        adapter_id: adapterId,
        schema_refs: [schemaRef],
        parameters_required: false,
        parameter_schema: emptyAdapterParameterSchema(),
        validateParameters: noAdapterParameters,
      })),
      ...formalRegistrations.map((registration) => {
        const tableId = tableBySchema.get(registration.schema.schema_id);
        if (tableId === undefined) throw new Error(`gut microbiome parser has unknown schema '${registration.schema.schema_id}'`);
        return registeredSource({
          source: `registered_gut_microbiome_${tableId}_${registration.parser.adapter_id}`,
          tableId,
          adapterId: registration.parser.adapter_id,
          schemaRef: registration.schema.schema_id,
        });
      }),
    ],
  });
}

export function inheritedDiseaseEvidenceFamilyDefinition(): DatasetFamilyDefinition {
  const registrations = createInheritedDiseaseEvidenceRegisteredTableRegistry().entries();
  const providerSources = [
    { source: "orphanet_en_product1", adapterId: "inherited_disease.orphanet_product1.v1" },
    { source: "orphanet_en_product6", adapterId: "inherited_disease.orphanet_product6.v1" },
    { source: "hgnc_approved", adapterId: "inherited_disease.hgnc_approved.v1" },
    { source: "clinvar_gene_esearch", adapterId: "inherited_disease.clinvar_gene_esearch.v1" },
    { source: "clingen_gene_validity", adapterId: "inherited_disease.clingen_gene_validity.v1" },
  ] as const;
  return registeredFamily({
    id: INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
    schemas: inheritedDiseaseEvidenceSchemas,
    profileRef: "inherited_disease_gene_evidence.release.v1",
    validationPolicy: inheritedDiseaseEvidenceValidationPolicy(),
    sources: [
      ...providerSources.map(({ source, adapterId }) => ({
        source,
        adapter_id: adapterId,
        schema_refs: [inheritedDiseaseEvidenceTables[2]!.schema.schema_id],
        parameters_required: false,
        parameter_schema: emptyAdapterParameterSchema(),
        validateParameters: noAdapterParameters,
      })),
      ...registrations.map((registration) => {
        const table = inheritedDiseaseEvidenceTables.find(
          (entry) => entry.schema.schema_id === registration.schema.schema_id,
        );
        if (table === undefined) {
          throw new Error(`inherited disease parser schema '${registration.schema.schema_id}' is not registered`);
        }
        return registeredSource({
          source: `registered_inherited_disease_${table.tableId}`,
          tableId: table.tableId,
          adapterId: registration.parser.adapter_id,
          schemaRef: registration.schema.schema_id,
        });
      }),
    ],
  });
}

export function bioactivityMeasurementFamilyDefinition(): DatasetFamilyDefinition {
  const entries = bioactivityTableEntries();
  const registrations = createBioactivityRegisteredTableRegistry().entries();
  return registeredFamily({
    id: BIOACTIVITY_FAMILY_ID,
    schemas: [...entries.map((entry) => entry.schema), bioactivityCompoundCrosswalkSchema],
    profileRef: "bioactivity_measurement.release.v1",
    validationPolicy: bioactivityValidationPolicy(),
    sources: [{
      source: "chembl",
      adapter_id: "bioactivity.chembl_json.v1",
      schema_refs: [entries.find((entry) => entry.tableId === "activities")!.schema.schema_id],
      parameters_required: false,
      parameter_schema: emptyAdapterParameterSchema(),
      validateParameters: noAdapterParameters,
    }, {
      source: "pubchem",
      table_id: "compound_crosswalks",
      adapter_id: "bioactivity.pubchem_identity.v1",
      schema_refs: [bioactivityCompoundCrosswalkSchema.schema_id],
      parameters_required: false,
      parameter_schema: emptyAdapterParameterSchema(),
      validateParameters: noAdapterParameters,
    }, ...registrations.map((registration) => {
      const entry = entries.find((item) => item.schema.schema_id === registration.schema.schema_id)!;
      return registeredSource({ source: `registered_bioactivity_${entry.tableId}`, tableId: entry.tableId, adapterId: registration.parser.adapter_id, schemaRef: registration.schema.schema_id });
    })],
  });
}

export function createDefaultDatasetFamilyRegistry(): DatasetFamilyRegistry {
  return new DatasetFamilyRegistry([
    geneExpressionFamilyDefinition(),
    literatureEvidenceFamilyDefinition(),
    targetEvidenceFamilyDefinition(),
    variantEvidenceFamilyDefinition(),
    proteinStructureFamilyDefinition(),
    bioactivityMeasurementFamilyDefinition(),
    gutMicrobiomeFamilyDefinition(),
    inheritedDiseaseEvidenceFamilyDefinition(),
  ]);
}
