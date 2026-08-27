import {
  ProviderCarrierTransformRegistry,
  type ProviderCarrierRows,
  type ProviderCarrierTransformInput,
} from "../runtime/provider-transforms.js";
import {
  assertGutMicrobiomeCarrierRows,
  parseGutMicrobiomeCarrier,
  type GutMicrobiomeCarrierRows,
} from "./gut-microbiome/index.js";
import {
  parseInheritedDiseaseEvidenceCarriers,
  type InheritedDiseaseEvidenceCarrier,
  type InheritedDiseaseEvidenceRows,
} from "./inherited-disease-evidence/index.js";

const GUT_MICROBIOME_FAMILY_ID = "gut_microbiome";
const INHERITED_DISEASE_FAMILY_ID = "inherited_disease_gene_evidence";
const GUT_STUDY_ENTITY_KEYS = ["study_id", "study_ids", "study", "study_accession"] as const;

const GUT_PROVIDER_ADAPTERS = new Map<string, ReadonlySet<string>>([
  ["mgnify.files.v1", new Set([
    "registered_gut_microbiome_study_json",
    "registered_gut_microbiome_taxon_long_tsv",
    "registered_gut_microbiome_taxon_json",
    "registered_gut_microbiome_differential_abundance_xlsx",
  ])],
  ["ncbi.taxonomy.files.v1", new Set([
    "gut_microbiome.ncbi_taxonomy_esearch_json.v1",
    "gut_microbiome.ncbi_taxonomy_efetch_xml.v1",
  ])],
  ["gmrepo.files.v1", new Set([
    "gut_microbiome.gmrepo_associated_species_json.v1",
  ])],
]);

function fail(message: string): never {
  throw new TypeError(`gut microbiome provider dispatch rejected: ${message}`);
}

function entityValue(input: ProviderCarrierTransformInput, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const values = input.entities?.[key];
    if (values !== undefined && values.length === 1 && values[0]!.trim() !== "") return values[0]!.trim();
  }
  return undefined;
}

function studyIdFor(input: ProviderCarrierTransformInput): string {
  const declaredKeys = GUT_STUDY_ENTITY_KEYS.filter((key) => input.entities?.[key] !== undefined);
  if (declaredKeys.length > 0) {
    if (declaredKeys.length !== 1) {
      fail(`binding '${input.bindingId}' must declare one study entity key`);
    }
    const values = input.entities?.[declaredKeys[0]!];
    if (values === undefined || values.length !== 1 || values[0]!.trim() === "") {
      fail(`binding '${input.bindingId}' must declare exactly one non-empty study entity`);
    }
    return values[0]!.trim();
  }
  if (input.accession !== null && input.accession !== undefined && input.accession.trim() !== "") {
    return input.accession.trim();
  }
  fail(`binding '${input.bindingId}' must declare exactly one study entity or accession`);
}

function assertGutBinding(input: ProviderCarrierTransformInput): void {
  const adapters = GUT_PROVIDER_ADAPTERS.get(input.providerId);
  if (adapters === undefined || !adapters.has(input.adapterId)) {
    fail(`provider '${input.providerId}' cannot dispatch adapter '${input.adapterId}'`);
  }
  const sourceByProvider: Readonly<Record<string, string>> = {
    "mgnify.files.v1": "mgnify",
    "ncbi.taxonomy.files.v1": "ncbi_taxonomy",
    "gmrepo.files.v1": "gmrepo",
  };
  if (sourceByProvider[input.providerId] !== input.source) {
    fail(`provider '${input.providerId}' cannot dispatch source '${input.source}'`);
  }
  const binding = input.tableId === undefined || input.inputRole === undefined || input.schemaRef === undefined
    ? null
    : { tableId: input.tableId, inputRole: input.inputRole, schemaRef: input.schemaRef };
  const expected = input.adapterId.includes("study_json")
    ? { tableId: "study_records", inputRole: "study", schemaRef: "gut_microbiome.study.v1" }
    : input.adapterId.includes("differential_abundance")
      ? { tableId: "differential_abundance_records", inputRole: "differential_abundance", schemaRef: "gut_microbiome.differential_abundance.v1" }
      : input.adapterId.includes("gmrepo")
        ? { tableId: "reference_prevalence_records", inputRole: "reference_prevalence", schemaRef: "gut_microbiome.reference_prevalence.v1" }
        : { tableId: "taxon_records", inputRole: "taxon", schemaRef: "gut_microbiome.taxon_records.v1" };
  if (binding !== null && JSON.stringify(binding) !== JSON.stringify(expected)) {
    fail(`adapter '${input.adapterId}' has an invalid table/input/schema binding`);
  }
  if (input.receipt.asset_ref.asset_id !== input.assetId) {
    fail(`binding '${input.bindingId}' asset receipt does not match asset_id`);
  }
  if (input.receipt.asset_ref.role !== "carrier") {
    fail(`binding '${input.bindingId}' requires a carrier-role asset receipt`);
  }
  const mediaTypesByAdapter: Readonly<Record<string, ReadonlySet<string>>> = {
    registered_gut_microbiome_study_json: new Set(["application/json", "application/vnd.api+json"]),
    registered_gut_microbiome_taxon_long_tsv: new Set(["text/tab-separated-values"]),
    registered_gut_microbiome_taxon_json: new Set(["application/json"]),
    registered_gut_microbiome_differential_abundance_xlsx: new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]),
    "gut_microbiome.ncbi_taxonomy_esearch_json.v1": new Set(["application/json", "text/plain"]),
    "gut_microbiome.ncbi_taxonomy_efetch_xml.v1": new Set(["application/xml", "text/xml", "text/plain"]),
    "gut_microbiome.gmrepo_associated_species_json.v1": new Set(["application/json"]),
  };
  if (!mediaTypesByAdapter[input.adapterId]?.has(input.receipt.media_type.toLowerCase())) {
    fail(`adapter '${input.adapterId}' does not accept media type '${input.receipt.media_type}'`);
  }
  if (input.receipt.source_id.trim() === "") fail(`binding '${input.bindingId}' has a blank source_id`);
}

function appendGutRows(target: {
  studies: GutMicrobiomeCarrierRows["studies"][number][];
  taxa: GutMicrobiomeCarrierRows["taxa"][number][];
  differentialAbundances: GutMicrobiomeCarrierRows["differentialAbundances"][number][];
  referencePrevalences: GutMicrobiomeCarrierRows["referencePrevalences"][number][];
  sources: GutMicrobiomeCarrierRows["sources"][number][];
}, rows: GutMicrobiomeCarrierRows): void {
  target.studies.push(...rows.studies);
  target.taxa.push(...rows.taxa);
  target.differentialAbundances.push(...rows.differentialAbundances);
  target.referencePrevalences.push(...rows.referencePrevalences);
  target.sources.push(...rows.sources);
}

function gutMicrobiomeRows(inputs: readonly ProviderCarrierTransformInput[]): ProviderCarrierRows {
  if (inputs.length === 0) fail("at least one provider carrier is required");
  const aggregate = {
    studies: [],
    taxa: [],
    differentialAbundances: [],
    referencePrevalences: [],
    sources: [],
  } as {
    studies: GutMicrobiomeCarrierRows["studies"][number][];
    taxa: GutMicrobiomeCarrierRows["taxa"][number][];
    differentialAbundances: GutMicrobiomeCarrierRows["differentialAbundances"][number][];
    referencePrevalences: GutMicrobiomeCarrierRows["referencePrevalences"][number][];
    sources: GutMicrobiomeCarrierRows["sources"][number][];
  };
  for (const input of inputs) {
    if (input.familyId !== GUT_MICROBIOME_FAMILY_ID) fail(`unexpected family '${input.familyId}'`);
    assertGutBinding(input);
    try {
      appendGutRows(aggregate, parseGutMicrobiomeCarrier({
        assetId: input.assetId,
        logicalFile: input.receipt.relative_path,
        retrievedAt: input.receipt.registered_at,
        mediaType: input.receipt.media_type,
        bytes: input.bytes,
        studyId: studyIdFor(input),
        adapterId: input.adapterId,
        sourceId: input.receipt.source_id,
        diseaseId: entityValue(input, ["disease_id", "disease", "mesh_id"]),
        diseaseName: entityValue(input, ["disease_name", "disease_label"]),
        hostTaxonId: entityValue(input, ["host_taxon_id", "host_taxon", "host_species_taxon_id"]),
      }));
    } catch (error) {
      // Live MGnify study carriers are JSON:API `data` envelopes whose
      // attributes never carry disease annotations; rewrite the bare parse
      // failure into the exact spec.entities remedy before it reaches the
      // agent as an opaque invalid_input.
      const missing = [
        entityValue(input, ["disease_id", "disease", "mesh_id"]) === undefined
          ? "'disease_id' (or 'disease'/'mesh_id', MeSH ID such as D003924)" : null,
        entityValue(input, ["disease_name", "disease_label"]) === undefined
          ? "'disease_name' (or 'disease_label')" : null,
        entityValue(input, ["host_taxon_id", "host_taxon", "host_species_taxon_id"]) === undefined
          ? "'host_taxon_id' (or 'host_taxon'/'host_species_taxon_id', e.g. 9606)" : null,
      ].filter((item): item is string => item !== null);
      if (
        input.adapterId === "registered_gut_microbiome_study_json" &&
        missing.length > 0 &&
        error instanceof TypeError &&
        /study\.(disease_id|disease_name|host_taxon_id) is required/.test(error.message)
      ) {
        fail(
          `binding '${input.bindingId}' cannot construct study_records from this JSON:API carrier: ` +
            `declare top-level spec.entities ${missing.join(", ")} — each exactly one non-empty string. ` +
            "These fields are never carried by MGnify JSON:API attributes and must not be sent as binding.parameters.",
        );
      }
      throw error;
    }
  }
  assertGutMicrobiomeCarrierRows(aggregate);
  return {
    study_records: aggregate.studies,
    taxon_records: aggregate.taxa,
    differential_abundance_records: aggregate.differentialAbundances,
    reference_prevalence_records: aggregate.referencePrevalences,
  };
}

function inheritedDiseaseRows(inputs: readonly ProviderCarrierTransformInput[]): ProviderCarrierRows {
  const carriers: InheritedDiseaseEvidenceCarrier[] = inputs.map((input) => ({
    source: input.source as InheritedDiseaseEvidenceCarrier["source"],
    sourceId: input.receipt.source_id,
    assetId: input.assetId,
    logicalFile: input.receipt.relative_path,
    retrievedAt: input.receipt.registered_at,
    bytes: input.bytes,
  }));
  const rows: InheritedDiseaseEvidenceRows = parseInheritedDiseaseEvidenceCarriers(carriers);
  return {
    gene_records: rows.gene_records,
    disease_records: rows.disease_records,
    gene_disease_records: rows.gene_disease_records,
    gene_evidence_crosswalk: rows.gene_evidence_crosswalk,
  };
}

export function createDefaultProviderCarrierTransformRegistry(): ProviderCarrierTransformRegistry {
  return new ProviderCarrierTransformRegistry([
    { familyId: GUT_MICROBIOME_FAMILY_ID, transform: gutMicrobiomeRows },
    { familyId: INHERITED_DISEASE_FAMILY_ID, transform: inheritedDiseaseRows },
  ]);
}
