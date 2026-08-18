import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  JsonValue,
  OperationResultManifest,
} from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  RegisteredTableAdapter,
  RegisteredTableRegistry,
  type RegisteredTableRow,
  type RegisteredTableSink,
} from "../src/dataset/adapters/registered/index.js";
import { createDefaultFamilyAssemblerRegistry } from "../src/dataset/assembly/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import {
  assembleLiteratureEvidenceCandidate,
  LITERATURE_EVIDENCE_FAMILY_ID,
  LITERATURE_EVIDENCE_ROW_GRANULARITY,
  literatureEvidenceAdapterRegistrations,
  literatureEvidenceTables,
  validateLiteratureEvidenceCandidate,
} from "../src/dataset/families/literature-evidence/index.js";
import type { CoreResolvedRegisteredAsset } from "../src/dataset/adapters/registered/types.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "literature-evidence");
const DIGEST = "c".repeat(64);
const ASSETS = [
  `asset_${"a".repeat(64)}`,
  `asset_${"b".repeat(64)}`,
] as const;
const tempRoots: string[] = [];

class MemorySink implements RegisteredTableSink {
  readonly rows: RegisteredTableRow[] = [];
  async writeRow(row: RegisteredTableRow): Promise<void> {
    this.rows.push(row);
  }
  writeRejectedRow(): void {
    throw new Error("test does not expect rejected rows");
  }
  commit(): void {}
  rollback(): void {}
}

function receipt(bytes: Buffer, sourceId: string, assetId: string) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (assetId !== `asset_${sha256}`) throw new Error("fixture asset ID must match its hash");
  return {
    schema_version: "1.0" as const,
    receipt_id: `receipt_${sourceId}`,
    task_id: "task_literature",
    asset_ref: { schema_version: "1.0" as const, asset_id: assetId, task_id: "task_literature", role: "source" as const },
    source_id: sourceId,
    relative_path: `source_assets/${sourceId}.json`,
    sha256,
    size_bytes: bytes.length,
    media_type: "application/json",
    registered_at: "2026-08-18T00:00:00Z",
    path_compatibility: { schema_version: "1.0" as const, mode: "asset_id" as const, legacy_path: null, telemetry_event: "asset_ref_used" as const },
  };
}

function adapterRegistry(): RegisteredTableRegistry {
  const registry = new RegisteredTableRegistry();
  for (const registration of literatureEvidenceAdapterRegistrations) registry.register(registration);
  return registry;
}

async function parseJsonFixture(
  fileName: string,
  registrationIndex: number,
  sourceId: string,
): Promise<MemorySink> {
  const bytes = await readFile(path.join(FIXTURES, fileName));
  const assetId = `asset_${createHash("sha256").update(bytes).digest("hex")}`;
  const registration = literatureEvidenceAdapterRegistrations[registrationIndex];
  if (registration === undefined) throw new Error("missing literature registration");
  const sink = new MemorySink();
  const asset: CoreResolvedRegisteredAsset = {
    registration_receipt: receipt(bytes, sourceId, assetId),
    content: (async function* () { yield bytes; })(),
  };
  await new RegisteredTableAdapter(adapterRegistry()).parse({
    schema_version: "1.0",
    task_id: "task_literature",
    asset_id: assetId,
    schema_ref: registration.schema.schema_id,
    adapter_id: registration.parser.adapter_id,
    parser_version: registration.parser.parser_version,
  }, asset, sink);
  return sink;
}

async function csvOperationResult(
  root: string,
  tableId: string,
  fileName: string,
  summary: Record<string, JsonValue>,
  operationKind: OperationResultManifest["operation_kind"] = "integrate",
): Promise<OperationResultManifest> {
  const bytes = await readFile(path.join(root, fileName));
  const fileStat = await stat(path.join(root, fileName));
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${tableId}`,
    task_id: "task_literature",
    build_id: "build_literature",
    operation_id: `${operationKind}_${tableId}`,
    operation_kind: operationKind,
    operation_attempt_id: `attempt_${tableId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: DIGEST,
    output_kind: operationKind === "assemble" ? "publication_candidate" : "integrated_table",
    output_summary: summary,
    output_files: [{
      relative_path: fileName,
      size_bytes: fileStat.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
    dependency_closure: {
      input_asset_ids: [...ASSETS],
      upstream_result_manifest_ids: [],
      parameter_digest: DIGEST,
      implementation_digest: DIGEST,
    },
    commit: { state: "committed", commit_id: `commit_${tableId}`, committed_at: "2026-08-18T00:00:00Z" },
    migration: { mode: "native", legacy_checkpoint_path: null, migrated_at: null },
  };
}

async function buildCandidate(root: string, sourceFile = "sources.csv", evidenceFile = "evidence.csv") {
  const summaries: Record<string, JsonValue> = {
    dataset_family: LITERATURE_EVIDENCE_FAMILY_ID,
    row_granularity: LITERATURE_EVIDENCE_ROW_GRANULARITY,
    tables: {},
  };
  const files = [evidenceFile, "papers.csv", sourceFile];
  const integrationFiles: OperationResultManifest["output_files"] = [];
  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    integrationFiles.push({ relative_path: file, size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const tableIds = literatureEvidenceTables.map(({ definition }) => definition.table_id);
  tableIds.forEach((tableId, index) => {
    const file = integrationFiles[index];
    if (file === undefined) throw new Error("missing integration file");
    (summaries.tables as Record<string, JsonValue>)[tableId] = {
      schema_ref: literatureEvidenceTables[index]!.schema.schema_id,
      row_count: tableId === "sources" ? 2 : 1,
      file_sha256: file.sha256,
    };
  });
  const integration = {
    ...(await csvOperationResult(root, "integration", files[0]!, summaries)),
    output_files: integrationFiles,
    dependency_closure: { input_asset_ids: [...ASSETS], upstream_result_manifest_ids: [], parameter_digest: DIGEST, implementation_digest: DIGEST },
  };
  const provenanceResults = await Promise.all(tableIds.map((tableId, index) => csvOperationResult(root, `provenance_${tableId}`, files[index]!, { table_id: tableId })));
  const confidenceResults = await Promise.all(tableIds.map((tableId, index) => csvOperationResult(root, `confidence_${tableId}`, files[index]!, { table_id: tableId })));
  const candidate = assembleLiteratureEvidenceCandidate({
    taskId: "task_literature",
    buildId: "build_literature",
    datasetFamily: LITERATURE_EVIDENCE_FAMILY_ID,
    rowGranularity: LITERATURE_EVIDENCE_ROW_GRANULARITY,
    schema: literatureEvidenceTables[0]!.schema,
    integrationResult: integration,
    registeredAssetIds: [...ASSETS],
    provenanceResults,
    confidenceResults,
  });
  return { candidate, integration, provenanceResults, confidenceResults };
}

async function copyFixtures(root: string, sourceFile = "sources.csv", evidenceFile = "evidence.csv"): Promise<void> {
  for (const file of [evidenceFile, "papers.csv", sourceFile]) {
    await writeFile(path.join(root, file), await readFile(path.join(FIXTURES, file)));
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("literature evidence family module", () => {
  it("parses structured non-Gold literature records and keeps source as a supporting carrier", async () => {
    const evidence = await parseJsonFixture("non-gold.valid.json", 0, "source_evidence_json");
    const papers = await parseJsonFixture("non-gold.valid.json", 1, "source_papers_json");
    const sources = await parseJsonFixture("non-gold.valid.json", 2, "source_sources_json");
    expect(evidence.rows).toHaveLength(1);
    expect(papers.rows).toHaveLength(1);
    expect(sources.rows).toHaveLength(2);
    expect(literatureEvidenceTables.map(({ definition }) => definition.role)).toEqual(["primary", "supporting", "supporting"]);
    expect(literatureEvidenceTables.map(({ definition }) => definition.table_id)).not.toContain("source");
    expect(createDefaultDatasetFamilyRegistry().list()).not.toContain(LITERATURE_EVIDENCE_FAMILY_ID);
    expect(createDefaultFamilyAssemblerRegistry().list()).not.toContain(LITERATURE_EVIDENCE_FAMILY_ID);
  });

  it("assembles a deterministic Core-only three-table candidate without paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "literature-evidence-trusted-"));
    const forbidden = await mkdtemp(path.join(os.tmpdir(), "literature-evidence-workspace-"));
    tempRoots.push(root, forbidden);
    await copyFixtures(root);
    const built = await buildCandidate(root);
    expect(built.candidate.candidate_id).toMatch(/^candidate_[0-9a-f]{32}$/);
    expect(built.candidate.tables.map((table) => table.definition.table_id)).toEqual([
      "literature_evidence", "papers", "sources",
    ]);
    expect(JSON.stringify(built.candidate)).not.toContain("csv");
    expect(built.candidate.registered_asset_ids).toEqual([...ASSETS].sort());
    const result = await validateLiteratureEvidenceCandidate({
      candidate: built.candidate,
      integration_result: built.integration,
      provenance_results: built.provenanceResults,
      confidence_results: built.confidenceResults,
      trusted_root: root,
      forbidden_roots: [forbidden],
    });
    expect(result.passed).toBe(true);
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
  });

  it("fails closed for a missing locator or a broken evidence-to-paper FK", async () => {
    const forbidden = await mkdtemp(path.join(os.tmpdir(), "literature-evidence-workspace-"));
    tempRoots.push(forbidden);
    const locatorRoot = await mkdtemp(path.join(os.tmpdir(), "literature-evidence-locator-"));
    tempRoots.push(locatorRoot);
    await copyFixtures(locatorRoot, "sources.bad-locator.csv");
    const locatorBuilt = await buildCandidate(locatorRoot, "sources.bad-locator.csv");
    const locatorResult = await validateLiteratureEvidenceCandidate({
      candidate: locatorBuilt.candidate,
      integration_result: locatorBuilt.integration,
      provenance_results: locatorBuilt.provenanceResults,
      confidence_results: locatorBuilt.confidenceResults,
      trusted_root: locatorRoot,
      forbidden_roots: [forbidden],
    });
    expect(locatorResult.passed).toBe(false);
    expect(locatorResult.checks).toContainEqual(expect.objectContaining({ check_id: "source_locator_closure", passed: false }));

    const fkRoot = await mkdtemp(path.join(os.tmpdir(), "literature-evidence-fk-"));
    tempRoots.push(fkRoot);
    await copyFixtures(fkRoot, "sources.csv", "evidence.bad-fk.csv");
    const fkBuilt = await buildCandidate(fkRoot, "sources.csv", "evidence.bad-fk.csv");
    const fkResult = await validateLiteratureEvidenceCandidate({
      candidate: fkBuilt.candidate,
      integration_result: fkBuilt.integration,
      provenance_results: fkBuilt.provenanceResults,
      confidence_results: fkBuilt.confidenceResults,
      trusted_root: fkRoot,
      forbidden_roots: [forbidden],
    });
    expect(fkResult.passed).toBe(false);
    expect(fkResult.checks).toContainEqual(expect.objectContaining({ scope: "evidence_paper", check_id: "foreign_key", passed: false }));
  });

  it("fails closed when table provenance is incomplete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "literature-evidence-provenance-"));
    const forbidden = await mkdtemp(path.join(os.tmpdir(), "literature-evidence-workspace-"));
    tempRoots.push(root, forbidden);
    await copyFixtures(root);
    const built = await buildCandidate(root);
    const result = await validateLiteratureEvidenceCandidate({
      candidate: {
        ...built.candidate,
        provenance_refs: built.candidate.provenance_refs.slice(0, -1),
      },
      integration_result: built.integration,
      provenance_results: built.provenanceResults,
      confidence_results: built.confidenceResults,
      trusted_root: root,
      forbidden_roots: [forbidden],
    });
    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({ check_id: "literature_family_contract", passed: false });
  });
});
