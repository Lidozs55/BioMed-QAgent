import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as XLSX from "xlsx";
import { afterEach, describe, expect, it } from "vitest";

import type { DatasetExecutionSpec, SourceAsset } from "../src/dataset/contracts/index.js";
import {
  GUT_MICROBIOME_FAMILY_ID,
  GUT_MICROBIOME_ROW_GRANULARITY,
  GUT_MICROBIOME_STUDY_SCHEMA_ID,
  parseGutMicrobiomeCarrier,
} from "../src/dataset/families/gut-microbiome/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import { datasetRouteCapabilities } from "../src/agent/tools/dataset-route-preflight.js";
import { SpecValidator } from "../src/dataset/validation/spec_validator.js";
import { executeRegisteredMultiTableBuild } from "../src/dataset/runtime/registered-multitable.js";
import { providerCarrierBinding } from "../src/dataset/runtime/provider-bindings.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const STUDY_ID = "MGYS00000001";
/** NCBI taxid used by the taxonomy + GMRepo fixtures so relations close. */
const STUDY_TAXON_ID = 1234;
const roots: string[] = [];

function sourceAssetFromReceipt(receipt: Awaited<ReturnType<SourceAssetRegistry["register"]>>): SourceAsset {
  return {
    schema_version: "1.0",
    asset_id: receipt.asset_ref.asset_id,
    kind: "source",
    relative_path: receipt.relative_path,
    sha256: receipt.sha256,
    size_bytes: receipt.size_bytes,
    media_type: receipt.media_type,
    generated_by_step_id: null,
    source_id: receipt.source_id,
    successful_attempt_id: receipt.receipt_id,
    derived_from_asset_id: null,
    data_level: "repository_processed",
  };
}

async function writeCarrier(
  taskRoot: string,
  name: string,
  bytes: Buffer,
  mediaType: string,
): Promise<{ relativePath: string; bytes: Buffer }> {
  void mediaType;
  const relativePath = `source_assets/${name}`;
  await mkdir(path.dirname(path.join(taskRoot, relativePath)), { recursive: true });
  await writeFile(path.join(taskRoot, relativePath), bytes);
  return { relativePath, bytes };
}

function xlsxCarrier(): Buffer {
  const header = [
    "study_id", "taxon_id", "comparison_id", "comparison_label",
    "effect_size", "p_value", "adjusted_p_value", "effect_direction",
  ];
  const row = [
    STUDY_ID,
    "1234",
    "case-control",
    "case vs control",
    1.5,
    0.01,
    0.02,
    "increase",
  ];
  const sheet = XLSX.utils.aoa_to_sheet([header, row]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "DifferentialAbundance");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

function spec(options: { requirementId: string; wrongProvider?: boolean; includeRegisteredBinding?: boolean; paperBinding?: boolean }): DatasetExecutionSpec {
  const providerForGmrepo = options.wrongProvider === true ? "mgnify.files.v1" : "gmrepo.files.v1";
  const differentialBinding = options.paperBinding === true
    ? {
      schema_version: "1.0" as const,
      binding_id: "binding_differential",
      source: "europepmc_supplement",
      acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: "europepmc.supplementary.v1", recipe_id: null, recipe_version: null },
      adapter_id: "gut_microbiome.paper_supplement_differential_abundance_csv.v1",
      accession: "PMC5090114",
      parameters: {},
    }
    : {
      schema_version: "1.0" as const,
      binding_id: "binding_differential",
      source: "mgnify",
      acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: "mgnify.files.v1", recipe_id: null, recipe_version: null },
      adapter_id: "registered_gut_microbiome_differential_abundance_xlsx",
      accession: STUDY_ID,
      parameters: {},
    };
  const bindings: DatasetExecutionSpec["source_bindings"] = [
    {
      schema_version: "1.0" as const,
      binding_id: "binding_study",
      source: "mgnify",
      acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: "mgnify.files.v1", recipe_id: null, recipe_version: null },
      adapter_id: "registered_gut_microbiome_study_json",
      accession: STUDY_ID,
      parameters: {},
    },
    {
      schema_version: "1.0" as const,
      binding_id: "binding_taxonomy_esearch_renamed",
      source: "ncbi_taxonomy",
      acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: "ncbi.taxonomy.files.v1", recipe_id: null, recipe_version: null },
      adapter_id: "gut_microbiome.ncbi_taxonomy_esearch_json.v1",
      accession: "Enterobacter aerogenes",
      parameters: {},
    },
    {
      schema_version: "1.0" as const,
      binding_id: "binding_taxonomy_efetch_renamed",
      source: "ncbi_taxonomy",
      acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: "ncbi.taxonomy.files.v1", recipe_id: null, recipe_version: null },
      adapter_id: "gut_microbiome.ncbi_taxonomy_efetch_xml.v1",
      accession: "548",
      parameters: {},
    },
    differentialBinding,
    {
      schema_version: "1.0" as const,
      binding_id: "binding_taxonomy_esearch",
      source: "ncbi_taxonomy",
      acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: "ncbi.taxonomy.files.v1", recipe_id: null, recipe_version: null },
      adapter_id: "gut_microbiome.ncbi_taxonomy_esearch_json.v1",
      accession: "Blautia obeum",
      parameters: {},
    },
    {
      schema_version: "1.0" as const,
      binding_id: "binding_taxonomy_efetch",
      source: "ncbi_taxonomy",
      acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: "ncbi.taxonomy.files.v1", recipe_id: null, recipe_version: null },
      adapter_id: "gut_microbiome.ncbi_taxonomy_efetch_xml.v1",
      accession: "1234",
      parameters: {},
    },
    {
      schema_version: "1.0" as const,
      binding_id: "binding_prevalence",
      source: "gmrepo",
      acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: providerForGmrepo, recipe_id: null, recipe_version: null },
      adapter_id: "gut_microbiome.gmrepo_taxon_phenotypes_json.v1",
      accession: String(STUDY_TAXON_ID),
      parameters: {},
    },
  ];
  if (options.includeRegisteredBinding === true) {
    bindings.push({
      schema_version: "1.0",
      binding_id: "binding_registered_extra",
      source: "registered_gut_microbiome_study_records",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "registered_asset", recipe_id: null, recipe_version: null },
      adapter_id: "registered_gut_microbiome_study_json",
      accession: null,
      parameters: {},
    });
  }
  return {
    schema_version: "1.0",
    requirement_id: options.requirementId,
    objective: "Publish a receipt-closed gut microbiome association fixture",
    dataset_family: GUT_MICROBIOME_FAMILY_ID,
    row_granularity: GUT_MICROBIOME_ROW_GRANULARITY,
    entities: { study_id: [STUDY_ID] },
    cohort_filters: {},
    required_fields: [],
    schema_ref: GUT_MICROBIOME_STUDY_SCHEMA_ID,
    source_bindings: bindings,
    normalization_profile_ref: "gut_microbiome.registered.v1",
    merge_strategy: "registered_multitable_identity",
    validation_profile_ref: "gut_microbiome.release.v1",
    output_format: "csv",
    target_entity_level: null,
  };
}

async function registerCarriers(
  taskId: string,
  taskRoot: string,
  options: { studyCarrier?: () => Buffer; paperCarrier?: () => Buffer } = {},
) {
  const studyBytes = options.studyCarrier?.() ?? Buffer.from(JSON.stringify({
    study: {
      study_id: STUDY_ID,
      study_accession: STUDY_ID,
      study_title: "Non-Gold microbiome fixture",
      disease_id: "D006262",
      disease_name: "Type 2 diabetes mellitus",
      host_taxon_id: "9606",
      sample_count: 2,
    },
  }));
  const study = await writeCarrier(taskRoot, "study.json", studyBytes, "application/json");
  const differential = options.paperCarrier !== undefined
    ? await writeCarrier(taskRoot, "paper-supplement.csv", options.paperCarrier(), "text/csv")
    : await writeCarrier(taskRoot, "differential.xlsx", xlsxCarrier(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const prevalence = await writeCarrier(taskRoot, "prevalence.json", Buffer.from(JSON.stringify({
    phenotypes_associated_with_taxon: [
      { disease: "D006262", term: "Health", ncbi_taxon_id: STUDY_TAXON_ID, samples: 2, all_samples: 4 },
    ],
  })), "application/json");
  const ncbiEsearch = await writeCarrier(taskRoot, "taxonomy-esearch.json", Buffer.from(JSON.stringify({
    esearchresult: { idlist: ["1234"], querytranslation: "Blautia obeum[SCIN]" },
  })), "application/json");
  const ncbiEfetch = await writeCarrier(taskRoot, "taxonomy-efetch.xml", Buffer.from(
    '<?xml version="1.0" ?><TaxaSet><Taxon>\n' +
    "  <TaxId>1234</TaxId>\n" +
    "  <ScientificName>Blautia obeum</ScientificName>\n" +
    "  <OtherNames>\n" +
    "    <Synonym>Blautia wexlerae homotypic group</Synonym>\n" +
    '    <Name><ClassCDE>misspelling</ClassCDE><DispName>Blautium obeum</DispName></Name>\n' +
    "  </OtherNames>\n" +
    "  <ParentTaxId>416390</ParentTaxId>\n" +
    "  <Rank>species</Rank>\n" +
    "  <Lineage>cellular organisms; Bacteria; Bacillati; Clostridia</Lineage>\n" +
    "  <LineageEx><Taxon><TaxId>1301</TaxId><ScientificName>Bacillati</ScientificName><Rank>phylum</Rank></Taxon></LineageEx>\n" +
    "  <AkaTaxIds><TaxId>642001</TaxId></AkaTaxIds>\n" +
    "</Taxon></TaxaSet>",
  ), "application/xml");
  const ncbiEsearchRenamed = await writeCarrier(taskRoot, "taxonomy-esearch-renamed.json", Buffer.from(JSON.stringify({
    esearchresult: { idlist: ["548"], querytranslation: "Enterobacter aerogenes[SCIN]" },
  })), "application/json");
  const ncbiEfetchRenamed = await writeCarrier(taskRoot, "taxonomy-efetch-renamed.xml", Buffer.from(
    "<TaxaSet><Taxon>" +
    "<TaxId>548</TaxId>" +
    "<ScientificName>Klebsiella aerogenes</ScientificName>" +
    "<OtherNames>" +
    '<Name><ClassCDE>equivalent name</ClassCDE><DispName>Enterobacter aerogenes</DispName></Name>' +
    '<Name><ClassCDE>synonym</ClassCDE><DispName>Aerobacter aerogenes</DispName></Name>' +
    "</OtherNames>" +
    "<ParentTaxId>570</ParentTaxId>" +
    "<Rank>species</Rank>" +
    "<Lineage>cellular organisms; Bacteria; Pseudomonadota; Enterobacterales</Lineage>" +
    "</Taxon></TaxaSet>",
  ), "application/xml");
  const registry = new SourceAssetRegistry(taskId, taskRoot);
  const receipts = {
    study: await registry.register({ sourceId: "source_mgnify_study_fixture", relativePath: study.relativePath, role: "carrier", mediaType: "application/json" }),
    ncbiEsearchRenamed: await registry.register({ sourceId: "source_ncbi_esearch_renamed_fixture", relativePath: ncbiEsearchRenamed.relativePath, role: "carrier", mediaType: "application/json" }),
    ncbiEfetchRenamed: await registry.register({ sourceId: "source_ncbi_efetch_renamed_fixture", relativePath: ncbiEfetchRenamed.relativePath, role: "carrier", mediaType: "application/xml" }),
    differential: await registry.register({
      sourceId: "source_mgnify_differential_fixture",
      relativePath: differential.relativePath,
      role: "carrier",
      mediaType: options.paperCarrier !== undefined ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    prevalence: await registry.register({ sourceId: "source_gmrepo_prevalence_fixture", relativePath: prevalence.relativePath, role: "carrier", mediaType: "application/json" }),
    ncbiEsearch: await registry.register({ sourceId: "source_ncbi_esearch_fixture", relativePath: ncbiEsearch.relativePath, role: "carrier", mediaType: "application/json" }),
    ncbiEfetch: await registry.register({ sourceId: "source_ncbi_efetch_fixture", relativePath: ncbiEfetch.relativePath, role: "carrier", mediaType: "application/xml" }),
  };
  return receipts;
}

describe("Gold10 gut microbiome provider runtime dispatch", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("registers fixed provider bindings for all promoted carrier roles", () => {
    expect(providerCarrierBinding("gut_microbiome", "mgnify", "registered_gut_microbiome_study_json", undefined, "mgnify.files.v1")).not.toBeNull();
    expect(providerCarrierBinding("gut_microbiome", "mgnify", "registered_gut_microbiome_differential_abundance_xlsx", undefined, "mgnify.files.v1")).not.toBeNull();
    expect(providerCarrierBinding("gut_microbiome", "ncbi_taxonomy", "gut_microbiome.ncbi_taxonomy_esearch_json.v1", undefined, "ncbi.taxonomy.files.v1")).not.toBeNull();
    expect(providerCarrierBinding("gut_microbiome", "ncbi_taxonomy", "gut_microbiome.ncbi_taxonomy_efetch_xml.v1", "gut_microbiome.taxon_name_crosswalk.v1", "ncbi.taxonomy.files.v1")).not.toBeNull();
    expect(providerCarrierBinding("gut_microbiome", "mgnify", "registered_gut_microbiome_taxon_long_tsv", undefined, "mgnify.files.v1")).toBeNull();
    expect(providerCarrierBinding("gut_microbiome", "gmrepo", "gut_microbiome.gmrepo_taxon_phenotypes_json.v1", undefined, "gmrepo.files.v1")).not.toBeNull();
    expect(providerCarrierBinding("gut_microbiome", "gmrepo", "gut_microbiome.gmrepo_taxon_phenotypes_json.v1", undefined, "mgnify.files.v1")).toBeNull();
    expect(providerCarrierBinding("gut_microbiome", "mgnify", "registered_gut_microbiome_study_json", "gut_microbiome.taxon_name_crosswalk.v1", "mgnify.files.v1")).toBeNull();
  });

  it("rejects an unadmitted provider during dynamic-family admission", () => {
    const registry = createDefaultDatasetFamilyRegistry();
    const validator = new SpecValidator(
      registry.schemaRegistry(),
      registry.validationProfileRefs(),
      registry,
    );
    const result = validator.validate(spec({ requirementId: "req_gold10_wrong_provider", wrongProvider: true }));
    expect(result.valid).toBe(false);
    expect(result.reason_codes).toContain("provider_binding_mismatch");
  });

  it("executes the registered multi-table runtime through provider transforms and exact asset closure", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "gold10-provider-runtime-"));
    roots.push(taskRoot);
    const taskId = "task_gold10_provider_runtime";
    const receipts = await registerCarriers(taskId, taskRoot);
    const sourceAssets = {
      binding_study: sourceAssetFromReceipt(receipts.study),
      binding_differential: sourceAssetFromReceipt(receipts.differential),
      binding_taxonomy_esearch: sourceAssetFromReceipt(receipts.ncbiEsearch),
      binding_taxonomy_efetch: sourceAssetFromReceipt(receipts.ncbiEfetch),
      binding_taxonomy_esearch_renamed: sourceAssetFromReceipt(receipts.ncbiEsearchRenamed),
      binding_taxonomy_efetch_renamed: sourceAssetFromReceipt(receipts.ncbiEfetchRenamed),
      binding_prevalence: sourceAssetFromReceipt(receipts.prevalence),
    };
    const registeredAssetIds = new Set(Object.values(sourceAssets).map((asset) => asset.asset_id));
    const result = await executeRegisteredMultiTableBuild({
      taskId,
      taskRoot,
      spec: spec({ requirementId: "req_gold10_provider_runtime" }),
      registeredAssetIds: Object.fromEntries(Object.entries(sourceAssets).map(([bindingId, asset]) => [bindingId, asset.asset_id])),
    });
    expect(result.publication.publicationId).toMatch(/^pub_req_gold10_provider_runtime_/);
    expect(result.manifest.tables.map((table) => table.table_id)).toEqual([
      "study_records",
      "taxon_records",
      "differential_abundance_records",
      "reference_prevalence_records",
    ]);
    expect(result.manifest.provenance_summary.source_count).toBe(registeredAssetIds.size);
    expect(result.candidate.registered_asset_ids.sort()).toEqual([...registeredAssetIds].sort());
    const output = await readFile(path.join(taskRoot, "dataset_runs", "run_test", "req_gold10_provider_runtime", "tables", "taxon_records.csv"), "utf8");
    const header = output.split("\n")[0]!;
    expect(header).toBe("ncbi_taxon_id,current_name,common_name,taxon_rank,parent_taxon_id,lineage,synonyms,equivalent_names,historical_names,name_change_observed,query_names,source_id,source_asset_id,source_locator");
    const rows = output.split("\n").slice(1).filter((line) => line.length > 0).map((line) => line.split(","));
    expect(rows).toHaveLength(2);
    const blautia = rows.find((cells) => cells[0] === "1234")!;
    expect(blautia[1]).toBe("Blautia obeum");
    expect(blautia[3]).toBe("species");
    expect(blautia[4]).toBe("416390");
    expect(blautia[5]).toBe("cellular organisms; Bacteria; Bacillati; Clostridia");
    expect(blautia[6]).toBe("Blautia wexlerae homotypic group");
    expect(blautia[7]).toBe("");
    expect(blautia[8]).toBe("");
    expect(blautia[9]).toBe("false");
    expect(blautia[10]).toBe("Blautia obeum");
    expect(blautia[11]).toBe("source_ncbi_efetch_fixture");
    const renamed = rows.find((cells) => cells[0] === "548")!;
    expect(renamed[1]).toBe("Klebsiella aerogenes");
    expect(renamed[6]).toBe("Aerobacter aerogenes");
    expect(renamed[7]).toBe("Enterobacter aerogenes");
    expect(renamed[9]).toBe("true");
    expect(renamed[10]).toBe("Enterobacter aerogenes");
  });

  it("executes the static route with a pre-supplied paper supplement CSV member binding", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "gold10-paper-binding-"));
    roots.push(taskRoot);
    const taskId = "task_gold10_paper_binding";
    const paperCsv = Buffer.from(
      '"Panel title with an embedded\nnewline",,,,,,,,\n' +
        "mOTU ,UDCA,,,GCDCA,,,,TLCA,,\n" +
        ",β,pvalue,q value,β,,q value,,β,pvalue\n" +
        "Blautia obeum,0.42,0.03,0.06,-0.25,0.5,0.6,,0.9,0.95\n" +
        "motu linkage group 349,0.1,0.2,0.3,-0.4,0.5,0.6,,0.7,0.8",
      "utf8",
    );
    const receipts = await registerCarriers(taskId, taskRoot, { paperCarrier: () => paperCsv });

    const registry = createDefaultDatasetFamilyRegistry();
    const validator = new SpecValidator(registry.schemaRegistry(), registry.validationProfileRefs(), registry);
    expect(validator.validate(spec({ requirementId: "req_gold10_paper_binding", paperBinding: true }))).toEqual({
      valid: true,
      reason_codes: [],
      reasons: [],
    });

    const result = await executeRegisteredMultiTableBuild({
      taskId,
      taskRoot,
      spec: spec({ requirementId: "req_gold10_paper_binding", paperBinding: true }),
      registeredAssetIds: {
        binding_study: receipts.study.asset_ref.asset_id,
        binding_differential: receipts.differential.asset_ref.asset_id,
        binding_taxonomy_esearch: receipts.ncbiEsearch.asset_ref.asset_id,
        binding_taxonomy_efetch: receipts.ncbiEfetch.asset_ref.asset_id,
        binding_taxonomy_esearch_renamed: receipts.ncbiEsearchRenamed.asset_ref.asset_id,
        binding_taxonomy_efetch_renamed: receipts.ncbiEfetchRenamed.asset_ref.asset_id,
        binding_prevalence: receipts.prevalence.asset_ref.asset_id,
      },
    });
    expect(result.publication.publicationId).toMatch(/^pub_req_gold10_paper_binding_/);
    const output = await readFile(path.join(taskRoot, "dataset_runs", "run_test", "req_gold10_paper_binding", "tables", "differential_abundance_records.csv"), "utf8");
    const lines = output.split("\n").filter((line) => line.length > 0);
    // Only Blautia obeum joins the ESearch resolution; the unresolved mOTU group is skipped.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("study_id,taxon_id,comparison_id,comparison_label,effect_size,p_value,adjusted_p_value,effect_direction,source_id,source_asset_id,source_locator");
    const firstRow = lines[1]!.split(",");
    expect(firstRow[0]).toBe(STUDY_ID);
    expect(firstRow[1]).toBe("1234");
    expect(firstRow[2]).toBe("paper_supplement__blautia_obeum__udca");
    expect(firstRow[3]).toBe("UDCA");
    expect(firstRow[4]).toBe("0.42");
    expect(firstRow[7]).toBe("increase");
  });

  it("fails closed on provider mismatch, wrong media, and mixed registered/provider bindings", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "gold10-provider-runtime-negative-"));
    roots.push(taskRoot);
    const taskId = "task_gold10_provider_runtime_negative";
    const receipts = await registerCarriers(taskId, taskRoot);
    const assets = {
      binding_study: receipts.study.asset_ref.asset_id,
      binding_differential: receipts.differential.asset_ref.asset_id,
      binding_taxonomy_esearch: receipts.ncbiEsearch.asset_ref.asset_id,
      binding_taxonomy_efetch: receipts.ncbiEfetch.asset_ref.asset_id,
      binding_taxonomy_esearch_renamed: receipts.ncbiEsearchRenamed.asset_ref.asset_id,
      binding_taxonomy_efetch_renamed: receipts.ncbiEfetchRenamed.asset_ref.asset_id,
      binding_prevalence: receipts.prevalence.asset_ref.asset_id,
    };
    await expect(executeRegisteredMultiTableBuild({
      taskId,
      taskRoot,
      spec: spec({ requirementId: "req_gold10_wrong_provider", wrongProvider: true }),
      registeredAssetIds: assets,
    })).rejects.toThrow(/provider|registered table capability|binding/);
    await expect(executeRegisteredMultiTableBuild({
      taskId,
      taskRoot,
      spec: spec({ requirementId: "req_gold10_mixed", includeRegisteredBinding: true }),
      registeredAssetIds: { ...assets, binding_registered_extra: receipts.study.asset_ref.asset_id },
    })).rejects.toThrow(/cannot mix provider and registered-table bindings/);
    const differentialBytes = await readFile(path.join(taskRoot, "source_assets/differential.xlsx"));
    expect(() => parseGutMicrobiomeCarrier({
      assetId: receipts.differential.asset_ref.asset_id,
      logicalFile: "differential.xlsx",
      retrievedAt: receipts.differential.registered_at,
      mediaType: "application/octet-stream",
      bytes: differentialBytes,
      studyId: STUDY_ID,
      adapterId: "registered_gut_microbiome_differential_abundance_xlsx",
      sourceId: receipts.differential.source_id,
    })).toThrow(/unapproved media type/);
  });

  it("declares required entity groups on family sources and route capabilities", () => {
    const definition = createDefaultDatasetFamilyRegistry().definitionsList()
      .find((family) => family.id === GUT_MICROBIOME_FAMILY_ID)!;
    const studySource = definition.sources.find(
      (source) => source.adapter_id === "registered_gut_microbiome_study_json",
    )!;
    expect(studySource.required_entity_groups).toEqual([
      ["study_id", "study_ids", "study", "study_accession"],
      ["disease_id", "disease", "mesh_id"],
      ["disease_name", "disease_label"],
      ["host_taxon_id", "host_taxon", "host_species_taxon_id"],
    ]);
    expect(definition.sources.some((source) => source.required_entity_groups === undefined)).toBe(true);
    const routeSources = datasetRouteCapabilities().static.families
      .find((family) => family.family_id === GUT_MICROBIOME_FAMILY_ID)!.sources;
    expect(routeSources.find((source) => source.source === "gmrepo")!.required_entities).toEqual([
      ["study_id", "study_ids", "study", "study_accession"],
    ]);
    expect(routeSources.find((source) => source.adapter_id === "registered_gut_microbiome_study_json")!
      .required_entities).toEqual([
      ["study_id", "study_ids", "study", "study_accession"],
      ["disease_id", "disease", "mesh_id"],
      ["disease_name", "disease_label"],
      ["host_taxon_id", "host_taxon", "host_species_taxon_id"],
    ]);
  });

  it("reports every binding-level accession/parameter violation in one validation pass", () => {
    const registry = createDefaultDatasetFamilyRegistry();
    const validator = new SpecValidator(registry.schemaRegistry(), registry.validationProfileRefs(), registry);
    const base = spec({ requirementId: "req_gold10_binding_checks" });
    const broken: DatasetExecutionSpec = {
      ...base,
      source_bindings: base.source_bindings.map((binding) => {
        if (binding.binding_id === "binding_study") {
          return { ...binding, accession: null, parameters: { disease_id: "D003924" } };
        }
        if (binding.binding_id === "binding_prevalence") {
          return { ...binding, accession: "D006262" };
        }
        return binding;
      }),
    };
    const result = validator.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.reason_codes).toContain("binding_accession_missing");
    expect(result.reason_codes).toContain("binding_parameters_rejected");
    expect(result.reason_codes).toContain("binding_accession_invalid");
    expect(result.reasons.join("\n")).toContain("MGYS00000322");
    expect(result.reasons.join("\n")).toContain("spec.entities");
  });

  it("still accepts entity-light specs statically because carriers may self-describe disease fields", () => {
    const registry = createDefaultDatasetFamilyRegistry();
    const validator = new SpecValidator(registry.schemaRegistry(), registry.validationProfileRefs(), registry);
    expect(validator.validate(spec({ requirementId: "req_gold10_entity_light" }))).toEqual({
      valid: true,
      reason_codes: [],
      reasons: [],
    });
  });

  it("accepts interchangeable alias entity keys during validation", () => {
    const registry = createDefaultDatasetFamilyRegistry();
    const validator = new SpecValidator(registry.schemaRegistry(), registry.validationProfileRefs(), registry);
    const aliasedSpec: DatasetExecutionSpec = {
      ...spec({ requirementId: "req_gold10_alias_entities" }),
      entities: {
        study_accession: [STUDY_ID],
        mesh_id: ["D006262"],
        disease_label: ["Type 2 diabetes mellitus"],
        host_taxon: ["9606"],
      },
    };
    expect(validator.validate(aliasedSpec)).toEqual({ valid: true, reason_codes: [], reasons: [] });
  });

  it("names the spec.entities remedy when study metadata is missing for JSON:API carriers", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "gold10-entity-remedy-"));
    roots.push(taskRoot);
    const taskId = "task_gold10_entity_remedy";
    const receipts = await registerCarriers(taskId, taskRoot, { studyCarrier: () => Buffer.from(JSON.stringify({
      data: {
        id: STUDY_ID,
        attributes: { accession: STUDY_ID, "study-name": "JSON API fixture", "samples-count": 3 },
      },
    })) });
    await expect(executeRegisteredMultiTableBuild({
      taskId,
      taskRoot,
      spec: spec({ requirementId: "req_gold10_entity_remedy" }),
      registeredAssetIds: {
        binding_study: receipts.study.asset_ref.asset_id,
        binding_differential: receipts.differential.asset_ref.asset_id,
        binding_taxonomy_esearch: receipts.ncbiEsearch.asset_ref.asset_id,
        binding_taxonomy_efetch: receipts.ncbiEfetch.asset_ref.asset_id,
        binding_taxonomy_esearch_renamed: receipts.ncbiEsearchRenamed.asset_ref.asset_id,
        binding_taxonomy_efetch_renamed: receipts.ncbiEfetchRenamed.asset_ref.asset_id,
        binding_prevalence: receipts.prevalence.asset_ref.asset_id,
      },
    })).rejects.toThrow(/declare top-level spec\.entities[\s\S]*disease_id[\s\S]*binding\.parameters/);
  });
});
