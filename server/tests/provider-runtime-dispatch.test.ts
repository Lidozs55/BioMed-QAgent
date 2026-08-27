import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DatasetExecutionSpec, SourceAsset } from "../src/dataset/contracts/index.js";
import {
  bioactivityActivitySchema,
  BIOACTIVITY_FAMILY_ID,
  BIOACTIVITY_ROW_GRANULARITY,
} from "../src/dataset/families/bioactivity-measurement/index.js";
import { targetEvidenceSchemas, TARGET_EVIDENCE_FAMILY_ID, TARGET_EVIDENCE_ROW_GRANULARITY } from "../src/dataset/families/target-evidence/index.js";
import { TypeScriptDatasetCore } from "../src/dataset/service/ts-core.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "target-evidence", "uniprot-api.non-gold.json");
const BIOACTIVITY_FIXTURES = path.join(import.meta.dirname, "fixtures", "bioactivity-measurement");
const EXACT_INCHI_KEY = "BSYNRYMUTXBXSQ-UHFFFAOYSA-N";
const OTHER_INCHI_KEY = "RZVAJINKPMORJF-UHFFFAOYSA-N";
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

function bioactivitySpec(options: {
  requirementId: string;
  includePubChem?: boolean;
  pubchemAccession?: string | null;
  entities?: Record<string, string[]>;
}): DatasetExecutionSpec {
  return {
    schema_version: "1.0",
    requirement_id: options.requirementId,
    objective: "Publish non-Gold receipt-backed bioactivity identity data",
    dataset_family: BIOACTIVITY_FAMILY_ID,
    row_granularity: BIOACTIVITY_ROW_GRANULARITY,
    entities: options.entities ?? {},
    cohort_filters: {},
    required_fields: bioactivityActivitySchema.fields.map((field) => field.name),
    schema_ref: bioactivityActivitySchema.schema_id,
    source_bindings: [{
      schema_version: "1.0",
      binding_id: "binding_chembl",
      source: "chembl",
      acquisition: {
        schema_version: "1.0",
        mode: "builtin",
        provider_id: "chembl.files.v1",
        recipe_id: null,
        recipe_version: null,
      },
      adapter_id: "bioactivity.chembl_json.v1",
      accession: null,
      parameters: {},
    }, ...(options.includePubChem === true ? [{
      schema_version: "1.0" as const,
      binding_id: "binding_pubchem",
      source: "pubchem",
      acquisition: {
        schema_version: "1.0" as const,
        mode: "builtin" as const,
        provider_id: "pubchem.files.v1",
        recipe_id: null,
        recipe_version: null,
      },
      adapter_id: "bioactivity.pubchem_identity.v1",
      accession: options.pubchemAccession ?? "2244",
      parameters: {},
    }] : [])],
    normalization_profile_ref: "bioactivity_measurement.registered.v1",
    merge_strategy: "registered_multitable_identity",
    validation_profile_ref: "bioactivity_measurement.release.v1",
    output_format: "csv",
    target_entity_level: null,
  };
}

async function registerBioactivityCarriers(options: {
  taskId: string;
  taskRoot: string;
  pubchemDocument?: unknown;
}) {
  await mkdir(path.join(options.taskRoot, "source_assets"), { recursive: true });
  const chemblPath = "source_assets/non-gold-chembl-identity.json";
  const pubchemPath = "source_assets/non-gold-pubchem-identity.json";
  await writeFile(
    path.join(options.taskRoot, chemblPath),
    await readFile(path.join(BIOACTIVITY_FIXTURES, "non-gold.chembl-identity-provider.json")),
  );
  const pubchemDocument = options.pubchemDocument ?? JSON.parse(
    await readFile(path.join(BIOACTIVITY_FIXTURES, "non-gold.pubchem-identity.json"), "utf8"),
  ) as unknown;
  await writeFile(path.join(options.taskRoot, pubchemPath), `${JSON.stringify(pubchemDocument)}\n`);
  const registry = new SourceAssetRegistry(options.taskId, options.taskRoot);
  const chembl = await registry.register({
    sourceId: "source_chembl_identity_fixture",
    relativePath: chemblPath,
    role: "carrier",
  });
  const pubchem = await registry.register({
    sourceId: "source_pubchem_identity_fixture",
    relativePath: pubchemPath,
    role: "carrier",
  });
  return { chembl, pubchem };
}

async function publicationDirectories(taskRoot: string, runId: string, requirementId: string): Promise<string[]> {
  try {
    return await readdir(path.join(taskRoot, "dataset_runs", runId, requirementId, "publish"));
  } catch (error) {
    if (error !== null && typeof error === "object" && Reflect.get(error, "code") === "ENOENT") return [];
    throw error;
  }
}

describe("provider runtime dispatch", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("publishes a native ChEMBL activity response through the bioactivity provider", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "provider-dispatch-chembl-"));
    roots.push(taskRoot);
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    const relativePath = "source_assets/chembl-activity.json";
    await writeFile(path.join(taskRoot, relativePath), JSON.stringify({
      activities: [{
        activity_id: 32260,
        assay_chembl_id: "CHEMBL674637",
        assay_description: "EGFR kinase inhibition",
        assay_type: "B",
        bao_format: "BAO_0000357",
        canonical_smiles: "C1=CC=CC=C1",
        molecule_chembl_id: "CHEMBL68920",
        molecule_pref_name: "FIXTURE INHIBITOR",
        relation: "=",
        standard_relation: "=",
        standard_type: "IC50",
        standard_units: "nM",
        standard_value: "41.0",
        target_chembl_id: "CHEMBL203",
        target_organism: "Homo sapiens",
        target_pref_name: "Epidermal growth factor receptor",
        units: "nM",
        value: "41.0",
      }],
      page_meta: { total_count: 1 },
    }));
    const registry = new SourceAssetRegistry("task_provider_chembl", taskRoot);
    const receipt = await registry.register({
      sourceId: "source_chembl_non_gold_fixture",
      relativePath,
      role: "carrier",
    });
    const spec = {
      schema_version: "1.0" as const,
      requirement_id: "build_provider_chembl",
      objective: "Publish fixed ChEMBL activity data",
      dataset_family: BIOACTIVITY_FAMILY_ID,
      row_granularity: BIOACTIVITY_ROW_GRANULARITY,
      entities: {},
      cohort_filters: {},
      required_fields: bioactivityActivitySchema.fields.map((field) => field.name),
      schema_ref: bioactivityActivitySchema.schema_id,
      source_bindings: [{
        schema_version: "1.0" as const,
        binding_id: "binding_chembl",
        source: "chembl",
        acquisition: {
          schema_version: "1.0" as const,
          mode: "builtin" as const,
          provider_id: "chembl.files.v1",
          recipe_id: null,
          recipe_version: null,
        },
        adapter_id: "bioactivity.chembl_json.v1",
        accession: null,
        parameters: {},
      }],
      normalization_profile_ref: "bioactivity_measurement.registered.v1",
      merge_strategy: "registered_multitable_identity",
      validation_profile_ref: "bioactivity_measurement.release.v1",
      output_format: "csv",
      target_entity_level: null,
    };
    const core = new TypeScriptDatasetCore({ taskId: "task_provider_chembl", taskRoot });

    const result = await core.executeDatasetExecution(spec, {
      runId: "run_provider_chembl",
      sourceAssets: { binding_chembl: sourceAssetFromReceipt(receipt) },
      registeredSourceAssetIds: new Set([receipt.asset_ref.asset_id]),
    });

    expect(result.status).toBe("completed");
    expect(result.publication_id).toMatch(/^pub_build_provider_chembl_/);
    expect(result.manifest?.schema_version).toBe("2.0");
    if (result.manifest?.schema_version !== "2.0") throw new Error("legacy bioactivity manifest is not v2");
    expect(result.manifest.tables.map((table) => table.table_id)).toEqual([
      "activities", "compounds", "assays", "targets",
    ]);
    expect(result.manifest.artifacts.map((artifact) => artifact.relative_path)).not.toContain(
      "product_assessment.json",
    );
  });

  it("publishes exact ChEMBL-PubChem identity as five receipt-closed tables", async () => {
    const taskId = "task_provider_bioactivity_identity";
    const requirementId = "build_provider_bioactivity_identity";
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "provider-dispatch-bioactivity-identity-"));
    roots.push(taskRoot);
    const carriers = await registerBioactivityCarriers({ taskId, taskRoot });
    const core = new TypeScriptDatasetCore({ taskId, taskRoot });

    const result = await core.executeDatasetExecution(bioactivitySpec({ requirementId, includePubChem: true }), {
      runId: "run_provider_bioactivity_identity",
      sourceAssets: {
        binding_chembl: sourceAssetFromReceipt(carriers.chembl),
        binding_pubchem: sourceAssetFromReceipt(carriers.pubchem),
      },
      registeredSourceAssetIds: new Set([
        carriers.chembl.asset_ref.asset_id,
        carriers.pubchem.asset_ref.asset_id,
      ]),
    });

    expect(result.status).toBe("completed");
    expect(result.manifest?.schema_version).toBe("2.0");
    if (result.manifest?.schema_version !== "2.0") throw new Error("identity manifest is not v2");
    const identityManifest = result.manifest;
    expect(identityManifest.tables.map((table) => table.table_id)).toEqual([
      "activities", "compounds", "assays", "targets", "compound_crosswalks",
    ]);
    expect(identityManifest.relations.map((relation) => relation.relation_id)).toEqual([
      "activity_compound", "activity_assay", "activity_target", "assay_target",
      "crosswalk_left_compound", "crosswalk_right_compound",
    ]);
    const assessmentArtifact = identityManifest.artifacts.find(
      (artifact) => artifact.relative_path === "product_assessment.json",
    );
    expect(assessmentArtifact).toMatchObject({ role: "audit_report" });

    const [version] = await publicationDirectories(taskRoot, "run_provider_bioactivity_identity", requirementId);
    expect(version).toBeDefined();
    const publicationDir = path.join(taskRoot, "dataset_runs", "run_provider_bioactivity_identity", requirementId, "publish", version!);
    const compounds = await readFile(path.join(publicationDir, "tables", "compounds.csv"), "utf8");
    const crosswalk = await readFile(path.join(publicationDir, "tables", "compound_crosswalks.csv"), "utf8");
    expect(compounds).toContain("CHEMBL_FIXTURE_25,chembl_compound");
    expect(compounds).toContain("2244,pubchem_cid");
    expect(crosswalk).toContain("CHEMBL_FIXTURE_25,chembl_compound,2244,pubchem_cid");
    expect(crosswalk).toContain("exact_inchi_key");
    expect(crosswalk).toContain("matched");

    const provenance = JSON.parse(
      await readFile(path.join(publicationDir, "provenance.json"), "utf8"),
    ) as { sources: Array<{ asset_id: string; receipt_id: string }> };
    expect(provenance.sources.map((source) => source.asset_id).sort()).toEqual([
      carriers.chembl.asset_ref.asset_id,
      carriers.pubchem.asset_ref.asset_id,
    ].sort());
    expect(provenance.sources.map((source) => source.receipt_id).sort()).toEqual([
      carriers.chembl.receipt_id,
      carriers.pubchem.receipt_id,
    ].sort());

    const assessment = JSON.parse(
      await readFile(path.join(publicationDir, "product_assessment.json"), "utf8"),
    ) as { product_status: string; blockers: unknown[]; scores: unknown[] };
    expect(assessment).toMatchObject({ product_status: "publishable", blockers: [] });
    expect(assessment.scores.length).toBeGreaterThan(0);

    const publishedManifest = JSON.parse(
      await readFile(path.join(publicationDir, "dataset_manifest.json"), "utf8"),
    ) as unknown;
    if (publishedManifest === null || typeof publishedManifest !== "object" ||
        !Array.isArray(Reflect.get(publishedManifest, "artifacts"))) {
      throw new Error("published identity manifest is invalid");
    }
    const publishedArtifacts = Reflect.get(publishedManifest, "artifacts") as typeof identityManifest.artifacts;
    expect(publishedArtifacts).toEqual(identityManifest.artifacts);
    for (const artifact of publishedArtifacts) {
      const bytes = await readFile(path.join(publicationDir, ...artifact.relative_path.split("/")));
      expect(bytes.length).toBe(artifact.size_bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
  });

  it("fails closed before publication when PubChem identity does not exactly match", async () => {
    const taskId = "task_provider_bioactivity_conflict";
    const requirementId = "build_provider_bioactivity_conflict";
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "provider-dispatch-bioactivity-conflict-"));
    roots.push(taskRoot);
    const document = JSON.parse(
      await readFile(path.join(BIOACTIVITY_FIXTURES, "non-gold.pubchem-identity.json"), "utf8"),
    ) as { PropertyTable: { Properties: Array<{ InChIKey: string }> } };
    document.PropertyTable.Properties[0]!.InChIKey = OTHER_INCHI_KEY;
    const carriers = await registerBioactivityCarriers({ taskId, taskRoot, pubchemDocument: document });
    const core = new TypeScriptDatasetCore({ taskId, taskRoot });

    await expect(core.executeDatasetExecution(bioactivitySpec({ requirementId, includePubChem: true }), {
      runId: "run_provider_bioactivity_conflict",
      sourceAssets: {
        binding_chembl: sourceAssetFromReceipt(carriers.chembl),
        binding_pubchem: sourceAssetFromReceipt(carriers.pubchem),
      },
      registeredSourceAssetIds: new Set([
        carriers.chembl.asset_ref.asset_id,
        carriers.pubchem.asset_ref.asset_id,
      ]),
    })).rejects.toThrow(/exact InChIKey|identity match|publishable/);
    expect(await publicationDirectories(taskRoot, "run_provider_bioactivity_conflict", requirementId)).toEqual([]);
  });

  it.each([
    ["malformed PubChem", { unexpected: true }, "2244", /PubChem|PropertyTable/],
    ["CID mismatch", { PropertyTable: { Properties: [{ CID: 9999, InChIKey: EXACT_INCHI_KEY }] } }, "2244", /CID does not match/],
  ])("fails closed on %s carrier data", async (_name, pubchemDocument, accession, error) => {
    const taskId = `task_provider_bioactivity_invalid_${accession}`;
    const requirementId = `build_provider_bioactivity_invalid_${accession}`;
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "provider-dispatch-bioactivity-invalid-"));
    roots.push(taskRoot);
    const carriers = await registerBioactivityCarriers({ taskId, taskRoot, pubchemDocument });
    const core = new TypeScriptDatasetCore({ taskId, taskRoot });

    await expect(core.executeDatasetExecution(bioactivitySpec({
      requirementId,
      includePubChem: true,
      pubchemAccession: accession,
    }), {
      runId: `run_provider_bioactivity_invalid_${accession}`,
      sourceAssets: {
        binding_chembl: sourceAssetFromReceipt(carriers.chembl),
        binding_pubchem: sourceAssetFromReceipt(carriers.pubchem),
      },
      registeredSourceAssetIds: new Set([
        carriers.chembl.asset_ref.asset_id,
        carriers.pubchem.asset_ref.asset_id,
      ]),
    })).rejects.toThrow(error);
    expect(await publicationDirectories(taskRoot, `run_provider_bioactivity_invalid_${accession}`, requirementId)).toEqual([]);
  });

  it("fails closed when the PubChem binding has no registered receipt", async () => {
    const taskId = "task_provider_bioactivity_missing_receipt";
    const requirementId = "build_provider_bioactivity_missing_receipt";
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "provider-dispatch-bioactivity-missing-"));
    roots.push(taskRoot);
    const carriers = await registerBioactivityCarriers({ taskId, taskRoot });
    const core = new TypeScriptDatasetCore({ taskId, taskRoot });

    await expect(core.executeDatasetExecution(bioactivitySpec({ requirementId, includePubChem: true }), {
      runId: "run_provider_bioactivity_missing_receipt",
      sourceAssets: { binding_chembl: sourceAssetFromReceipt(carriers.chembl) },
      registeredSourceAssetIds: new Set([carriers.chembl.asset_ref.asset_id]),
    })).rejects.toThrow(/binding_pubchem.*registered carrier asset ID|registered carrier asset ID.*binding_pubchem/);
    expect(await publicationDirectories(taskRoot, "run_provider_bioactivity_missing_receipt", requirementId)).toEqual([]);
  });

  it("publishes a registered target carrier through executeDatasetExecution", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "provider-dispatch-e2e-"));
    roots.push(taskRoot);
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    const relativePath = "source_assets/uniprot.json";
    await writeFile(path.join(taskRoot, relativePath), await readFile(FIXTURE));
    const registry = new SourceAssetRegistry("task_provider_dispatch", taskRoot);
    const receipt = await registry.register({
      sourceId: "provider_uniprot_carrier",
      relativePath,
      role: "carrier",
    });
    const primarySchema = targetEvidenceSchemas[0]!;
    const sourceAsset = sourceAssetFromReceipt(receipt);
    const spec = {
      schema_version: "1.0" as const,
      requirement_id: "build_provider_dispatch",
      objective: "Publish a target carrier",
      dataset_family: TARGET_EVIDENCE_FAMILY_ID,
      row_granularity: TARGET_EVIDENCE_ROW_GRANULARITY,
      entities: {},
      cohort_filters: {},
      required_fields: primarySchema.fields.map((field) => field.name),
      schema_ref: primarySchema.schema_id,
      source_bindings: [{
        schema_version: "1.0" as const,
        binding_id: "binding_uniprot_carrier",
        source: "uniprot",
        acquisition: {
          schema_version: "1.0" as const,
          mode: "builtin" as const,
          provider_id: "uniprot.provider.v1",
          recipe_id: null,
          recipe_version: null,
        },
        adapter_id: "target.evidence.uniprot.v1",
        accession: null,
        parameters: {},
      }],
      normalization_profile_ref: "target_evidence.registered.v1",
      merge_strategy: "registered_multitable_identity",
      validation_profile_ref: "target_evidence.release.v1",
      output_format: "csv",
      target_entity_level: null,
    };
    const core = new TypeScriptDatasetCore({ taskId: "task_provider_dispatch", taskRoot });
    const result = await core.executeDatasetExecution(spec, {
      runId: "run_provider_dispatch",
      sourceAssets: { binding_uniprot_carrier: sourceAsset },
      registeredSourceAssetIds: new Set([receipt.asset_ref.asset_id]),
    });

    expect(result.status).toBe("completed");
    expect(result.publication_id).toMatch(/^pub_build_provider_dispatch_/);
    expect(result.manifest?.schema_version).toBe("2.0");
    const manifest = result.manifest;
    if (manifest?.schema_version !== "2.0") throw new Error("provider dispatch did not produce a v2 manifest");
    expect(manifest.tables.map((table) => table.table_id)).toEqual([
      "targets", "evidence", "sources", "supporting",
    ]);
    const publicationEntries = await readdir(path.join(taskRoot, "dataset_runs", "run_provider_dispatch", spec.requirement_id, "publish"));
    expect(publicationEntries).toHaveLength(1);
    const publicationDir = path.join(taskRoot, "dataset_runs", "run_provider_dispatch", spec.requirement_id, "publish", publicationEntries[0]!);
    expect(await stat(path.join(publicationDir, "dataset_manifest.json"))).toMatchObject({});
    expect(await readFile(path.join(publicationDir, "tables", "targets.csv"), "utf8")).toContain("Q9Y243");

    const invalidRelativePath = "source_assets/invalid.json";
    await writeFile(path.join(taskRoot, invalidRelativePath), JSON.stringify({ unexpected: true }));
    const invalidReceipt = await registry.register({
      sourceId: "provider_invalid_carrier",
      relativePath: invalidRelativePath,
      role: "carrier",
    });
    await expect(core.executeDatasetExecution({ ...spec, requirement_id: "build_provider_dispatch_invalid" }, {
      runId: "run_provider_dispatch_invalid",
      sourceAssets: { binding_uniprot_carrier: sourceAssetFromReceipt(invalidReceipt) },
      registeredSourceAssetIds: new Set([invalidReceipt.asset_ref.asset_id]),
    })).rejects.toThrow(/target evidence provider rejected/);
  });
});
