import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { executeRegisteredMultiTableBuild } from "../src/dataset/runtime/registered-multitable.js";
import {
  INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
  INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY,
  type InheritedDiseaseEvidenceCarrier,
  type InheritedDiseaseEvidenceSource,
  inheritedDiseaseEvidenceTables,
  parseInheritedDiseaseEvidenceCarriers,
} from "../src/dataset/families/inherited-disease-evidence/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import { createDefaultFamilyAssemblerRegistry } from "../src/dataset/assembly/index.js";
import { providerCarrierBinding } from "../src/dataset/runtime/provider-bindings.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "inherited-disease-evidence");
const tempRoots: string[] = [];

async function fixture(name: string): Promise<Buffer> {
  return readFile(path.join(FIXTURES, name));
}

function assetId(bytes: Buffer): string {
  return `asset_${createHash("sha256").update(bytes).digest("hex")}`;
}

async function registerCarrier(root: string, taskId: string, sourceId: string, fileName: string) {
  await mkdir(path.join(root, "source_assets"), { recursive: true });
  await writeFile(path.join(root, "source_assets", fileName), await fixture(fileName));
  return new SourceAssetRegistry(taskId, root).register({
    sourceId,
    relativePath: `source_assets/${fileName}`,
    role: "carrier",
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("inherited disease evidence family", () => {
  it("declares the stable generic four-table Schema 2.0 contract", () => {
    const family = createDefaultDatasetFamilyRegistry().get(INHERITED_DISEASE_EVIDENCE_FAMILY_ID);
    expect(family.id).toBe("inherited_disease_gene_evidence");
    expect(family.runtime_id).toBe("registered_multitable.runtime.v1");
    expect(inheritedDiseaseEvidenceTables.map((entry) => entry.definition.table_id)).toEqual([
      "gene_records",
      "disease_records",
      "gene_disease_records",
      "gene_evidence_crosswalk",
    ]);
    expect(inheritedDiseaseEvidenceTables.map((entry) => entry.definition.role)).toEqual([
      "supporting",
      "supporting",
      "primary",
      "supporting",
    ]);
    expect(inheritedDiseaseEvidenceTables.map((entry) => entry.schema.schema_version)).toEqual([
      "2.0", "2.0", "2.0", "2.0",
    ]);
    expect(inheritedDiseaseEvidenceTables[0]!.definition.primary_key).toEqual(["gene_id", "gene_namespace"]);
    expect(inheritedDiseaseEvidenceTables[1]!.definition.primary_key).toEqual(["disease_id", "disease_namespace"]);
    expect(inheritedDiseaseEvidenceTables[2]!.definition.primary_key).toEqual(["gene_disease_id"]);
    expect(inheritedDiseaseEvidenceTables[3]!.definition.primary_key).toEqual(["crosswalk_id"]);
    expect(inheritedDiseaseEvidenceTables[2]!.schema.fields.map((field) => field.name)).toEqual([
      "gene_disease_id", "gene_id", "gene_namespace", "disease_id", "disease_namespace",
      "association_type", "classification", "source_id", "source_locator",
    ]);
    expect(inheritedDiseaseEvidenceTables[3]!.schema.fields.map((field) => field.name)).toContain("evidence_id");
    expect(inheritedDiseaseEvidenceTables[2]!.definition.field_names).toEqual(
      inheritedDiseaseEvidenceTables[2]!.schema.fields.map((field) => field.name),
    );
    expect(inheritedDiseaseEvidenceTables[2]!.schema.dataset_family).toBe(INHERITED_DISEASE_EVIDENCE_FAMILY_ID);
    expect(createDefaultFamilyAssemblerRegistry().list()).toContain(INHERITED_DISEASE_EVIDENCE_FAMILY_ID);
    expect(providerCarrierBinding(INHERITED_DISEASE_EVIDENCE_FAMILY_ID, "orphanet_en_product1", "inherited_disease.orphanet_product1.v1")).not.toBeNull();
  });

  it("parses all four official response carriers deterministically without data/gold inputs", async () => {
    const names = ["orphanet-product1.xml", "orphanet-product6.xml", "hgnc-approved.tsv", "clinvar-gene-esearch.json", "clingen-gene-validity.csv"] as const;
    const carriers: InheritedDiseaseEvidenceCarrier[] = [];
    for (const name of names) {
      const bytes = await fixture(name);
      carriers.push({
        source: (name.startsWith("orphanet") ? name.includes("product1") ? "orphanet_en_product1" : "orphanet_en_product6" : name.startsWith("hgnc") ? "hgnc_approved" : name.startsWith("clinvar") ? "clinvar_gene_esearch" : "clingen_gene_validity") as InheritedDiseaseEvidenceSource,
        sourceId: `source_${name.replaceAll(".", "_")}`,
        assetId: assetId(bytes),
        logicalFile: `source_assets/${name}`,
        retrievedAt: "2026-08-18T00:00:00.000Z",
        bytes,
      });
    }
    const first = parseInheritedDiseaseEvidenceCarriers(carriers);
    const second = parseInheritedDiseaseEvidenceCarriers(carriers);
    expect(first).toEqual(second);
    expect(first.gene_records).toHaveLength(1);
    expect(first.disease_records).toHaveLength(1);
    expect(first.gene_disease_records).toHaveLength(1);
    expect(first.gene_evidence_crosswalk).toHaveLength(1);
    expect(first.gene_records[0]).toMatchObject({ gene_id: "HGNC:12345", gene_symbol: "NGD1" });
    expect(first.disease_records[0]).toMatchObject({ disease_id: "ORPHA:101", disease_name: "Non-Gold immune deficiency", omim_id: "OMIM:612345" });
    expect(first.gene_disease_records[0]).toMatchObject({ gene_id: "HGNC:12345", disease_id: "ORPHA:101", classification: "Definitive" });
    expect(first.gene_evidence_crosswalk[0]).toMatchObject({ evidence_id: "clinvar_gene_esearch", gene_id: "HGNC:12345", pathogenic_count: 7 });
    const invalidClinvar = carriers.map((carrier) => carrier.source === "clinvar_gene_esearch"
      ? { ...carrier, bytes: Buffer.from(JSON.stringify({ esearchresult: { count: "7", querytranslation: "NGD1[gene]" } })) }
      : carrier);
    expect(() => parseInheritedDiseaseEvidenceCarriers(invalidClinvar)).toThrow(/pathogenic|retmax/);
  });

  it("fails closed on malformed XML, missing crosswalk gene, and conflicting classifications", async () => {
    const bytes = await fixture("orphanet-product1.xml");
    const carriers: InheritedDiseaseEvidenceCarrier[] = [{ source: "orphanet_en_product1", sourceId: "source_one", assetId: assetId(bytes), logicalFile: "source_assets/orphanet-product1.xml", retrievedAt: "2026-08-18T00:00:00.000Z", bytes }];
    expect(() => parseInheritedDiseaseEvidenceCarriers([{ ...carriers[0]!, bytes: Buffer.from("<JDBOR>") }])).toThrow(/malformed|XML/);
    const hgnc = await fixture("hgnc-approved.tsv");
    expect(() => parseInheritedDiseaseEvidenceCarriers([
      ...carriers,
      { source: "hgnc_approved" as const, sourceId: "source_hgnc", assetId: assetId(hgnc), logicalFile: "source_assets/hgnc-approved.tsv", retrievedAt: "2026-08-18T00:00:00.000Z", bytes: Buffer.from("hgnc_id\tsymbol\tname\tstatus\nHGNC:99999\tOTHER\tOther\tApproved\n") },
    ])).toThrow(/gene|crosswalk|HGNC/);
  });

  it("publishes non-Gold fixtures through the formal registered Core path and detects hash drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inherited-disease-publication-"));
    tempRoots.push(root);
    const taskId = "task_inherited_disease";
    const files = ["orphanet-product1.xml", "orphanet-product6.xml", "hgnc-approved.tsv", "clinvar-gene-esearch.json", "clingen-gene-validity.csv"] as const;
    const receipts: Array<Awaited<ReturnType<SourceAssetRegistry["register"]>>> = [];
    for (const fileName of files) {
      receipts.push(await registerCarrier(root, taskId, `source_${fileName.replaceAll(".", "_")}`, fileName));
    }
    const bindings = [
      ["product1", "orphanet_en_product1", "inherited_disease.orphanet_product1.v1", "orphanet.en_product1.v1"],
      ["product6", "orphanet_en_product6", "inherited_disease.orphanet_product6.v1", "orphanet.en_product6.v1"],
      ["hgnc", "hgnc_approved", "inherited_disease.hgnc_approved.v1", "hgnc.approved.v1"],
      ["clinvar", "clinvar_gene_esearch", "inherited_disease.clinvar_gene_esearch.v1", "clinvar.gene-esearch.v1"],
      ["clingen", "clingen_gene_validity", "inherited_disease.clingen_gene_validity.v1", "clingen.gene-validity.v1"],
    ] as const;
    const sourceBindings = bindings.map(([bindingId, source, adapterId, providerId]) => ({
      schema_version: "1.0" as const,
      binding_id: bindingId,
      source,
      acquisition: { schema_version: "1.0" as const, mode: "builtin" as const, provider_id: providerId, recipe_id: null, recipe_version: null },
      adapter_id: adapterId,
      accession: null,
      parameters: {},
    }));
    const result = await executeRegisteredMultiTableBuild({
      taskId,
      taskRoot: root,
      spec: {
        schema_version: "1.0",
        build_id: "build_inherited_disease",
        objective: "Build inherited disease gene evidence",
        dataset_family: INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
        row_granularity: INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY,
        entities: {}, cohort_filters: {}, required_fields: [],
        schema_ref: "inherited_disease_gene_evidence.gene_disease.v1",
        source_bindings: sourceBindings,
        normalization_profile_ref: "inherited_disease_gene_evidence.registered.v1",
        merge_strategy: "registered_multitable_identity",
        validation_profile_ref: "inherited_disease_gene_evidence.release.v1",
        output_format: "csv", target_entity_level: null,
      },
      registeredAssetIds: Object.fromEntries(bindings.map(([bindingId], index) => [bindingId, receipts[index]!.asset_ref.asset_id])),
      publishedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(result.validation.status).toBe("passed");
    expect(result.manifest.tables.map((table) => table.table_id)).toEqual([
      "gene_records", "disease_records", "gene_disease_records", "gene_evidence_crosswalk",
    ]);
    expect(result.publication.publicationId).toMatch(/^pub_build_inherited_disease_/);
    const driftFile = path.join(root, "source_assets", "clinvar-gene-esearch.json");
    await writeFile(driftFile, "drift\n");
    await expect((async () => {
      const resolved = await new SourceAssetRegistry(taskId, root).resolveAny(receipts[3]!.asset_ref.asset_id);
      for await (const chunk of resolved.content) void chunk;
    })()).rejects.toThrow(/drift/);
  });

});
