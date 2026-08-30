import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { DiscoveryQueryRecord, EventEnvelope } from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildSourceCoverageReport,
  SOURCE_COVERAGE_ARTIFACT_FILE,
} from "../src/dataset/audit/source-coverage.js";
import { executeRegisteredMultiTableBuild } from "../src/dataset/runtime/registered-multitable.js";
import {
  literatureEvidenceAdapterRegistrations,
  literatureEvidenceTables,
  LITERATURE_EVIDENCE_FAMILY_ID,
  LITERATURE_EVIDENCE_ROW_GRANULARITY,
} from "../src/dataset/families/literature-evidence/index.js";
import { projectDiscoveryQueries } from "../src/runtime/discovery-ledger.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const SHA256 = "a".repeat(64);
const FIXTURES = path.join(import.meta.dirname, "fixtures", "literature-evidence");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function binding(index: number) {
  return {
    schema_version: "1.0" as const,
    binding_id: `b${index}`,
    source: `registered_literature_${literatureEvidenceTables[index]!.definition.table_id}`,
    acquisition: {
      schema_version: "1.0" as const,
      mode: "builtin" as const,
      provider_id: "registered_asset",
      recipe_id: null,
      recipe_version: null,
    },
    adapter_id: literatureEvidenceAdapterRegistrations[index]!.parser.adapter_id,
    accession: null,
    parameters: {},
  };
}

function buildSpec() {
  return {
    schema_version: "1.0" as const,
    requirement_id: "build_coverage",
    objective: "source coverage evidence",
    dataset_family: LITERATURE_EVIDENCE_FAMILY_ID,
    row_granularity: LITERATURE_EVIDENCE_ROW_GRANULARITY,
    entities: {},
    cohort_filters: {},
    required_fields: literatureEvidenceTables[0]!.schema.fields.map((field) => field.name),
    schema_ref: literatureEvidenceTables[0]!.schema.schema_id,
    source_bindings: [binding(0), binding(1), binding(2)],
    normalization_profile_ref: "literature_evidence.registered.v1",
    merge_strategy: "registered_multitable_identity",
    validation_profile_ref: "literature_evidence.release.v1",
    output_format: "csv",
    target_entity_level: null,
  };
}

function asset(index: number) {
  return {
    asset_id: `asset_${String(index).padStart(2, "0")}${SHA256.slice(2)}`,
    sha256: SHA256,
    size_bytes: 100 + index,
    media_type: "application/json",
  };
}

function receiptFor(index: number, assetId: string) {
  return {
    schema_version: "1.0" as const,
    receipt_id: `receipt_b${index}`,
    task_id: "task_coverage",
    asset_ref: {
      schema_version: "1.0" as const,
      asset_id: assetId,
      task_id: "task_coverage",
      role: "source" as const,
    },
    source_id: `b${index}`,
    relative_path: `source_assets/b${index}.json`,
    sha256: SHA256,
    size_bytes: 100 + index,
    media_type: "application/json",
    registered_at: `2026-08-30T00:00:0${index}.000Z`,
    path_compatibility: {
      schema_version: "1.0" as const,
      mode: "asset_id" as const,
      legacy_path: null,
      telemetry_event: "asset_ref_used" as const,
    },
  };
}

function discoveryRecord(operationId: string, status: DiscoveryQueryRecord["status"]) {
  return {
    operation_id: operationId,
    source: "pubmed",
    query: "egfr",
    status,
    result_count: status === "failed" ? 0 : 3,
    requested_limit: null,
    retrieved_at: "2026-08-30T00:00:09.000Z",
  };
}

describe("source coverage report builder", () => {
  it("is byte-deterministic for identical build state", () => {
    const input = {
      taskId: "task_coverage",
      spec: buildSpec(),
      sourceAssets: { b0: asset(0), b1: asset(1), b2: asset(2) },
      registrationReceipts: [receiptFor(0, asset(0).asset_id), receiptFor(1, asset(1).asset_id), receiptFor(2, asset(2).asset_id)],
      canonicalResults: [],
      integratedRows: 42,
      discoveryQueries: [discoveryRecord("tool:pubmed:query:2", "failed"), discoveryRecord("tool:pubmed:query:1", "success")],
    };
    const first = JSON.stringify(buildSourceCoverageReport(input));
    const second = JSON.stringify(buildSourceCoverageReport(input));
    expect(second).toBe(first);
  });

  it("scopes coverage to the spec universe and makes partial failure explicit", () => {
    const report = buildSourceCoverageReport({
      taskId: "task_coverage",
      spec: buildSpec(),
      sourceAssets: { b0: asset(0) },
      registrationReceipts: [receiptFor(0, asset(0).asset_id)],
      bindingFailures: new Map([["b2", "upstream_404"]]),
      discoveryQueries: [discoveryRecord("tool:pubmed:query:1", "failed")],
    });
    expect(report.universe_scope).toBe("spec_source_bindings");
    expect(report.scope_note).toContain("not a claim of exhaustive web coverage");
    expect(report.query_plan.map((entry) => entry.binding_id)).toEqual(["b0", "b1", "b2"]);
    const failed = report.acquisition_coverage.find((entry) => entry.binding_id === "b2");
    expect(failed?.status).toBe("failed");
    expect(failed?.exclusion_reasons).toContain("upstream_404");
    const missing = report.acquisition_coverage.find((entry) => entry.binding_id === "b1");
    expect(missing?.status).toBe("not_attempted");
    expect(report.summary).toMatchObject({ universe_total: 3, acquired: 1, failed: 1, not_attempted: 1, discovery_failed: 1 });
  });

  it("sorts discovery records and fails closed on a hostile ledger", () => {
    const report = buildSourceCoverageReport({
      taskId: "task_coverage",
      spec: buildSpec(),
      sourceAssets: { b0: asset(0) },
      registrationReceipts: [receiptFor(0, asset(0).asset_id)],
      discoveryQueries: [
        discoveryRecord("tool:pubmed:query:2", "success"),
        discoveryRecord("tool:pubmed:query:1", "success"),
      ],
    });
    expect(report.discovery_queries?.map((record) => record.operation_id)).toEqual([
      "tool:pubmed:query:1",
      "tool:pubmed:query:2",
    ]);
    expect(() =>
      buildSourceCoverageReport({
        taskId: "task_coverage",
        spec: buildSpec(),
        sourceAssets: {},
        registrationReceipts: [],
        discoveryQueries: [
          discoveryRecord("tool:pubmed:query:1", "success"),
          discoveryRecord("tool:pubmed:query:1", "failed"),
        ],
      }),
    ).toThrow(/duplicates operation_id/);
    expect(() =>
      buildSourceCoverageReport({
        taskId: "task_coverage",
        spec: buildSpec(),
        sourceAssets: {},
        registrationReceipts: [],
        discoveryQueries: [{ ...discoveryRecord("tool:pubmed:query:1", "made_up" as DiscoveryQueryRecord["status"]) }],
      }),
    ).toThrow();
  });
});

describe("discovery ledger event projection", () => {
  const envelope = (
    sequence: number,
    timestamp: string,
    payload: EventEnvelope["payload"],
  ): EventEnvelope => ({
    schema_version: "2.0",
    event_id: `event_${sequence}`,
    type: payload.type,
    task_id: "task_coverage",
    run_id: "run_coverage",
    stage_attempt_id: null,
    sequence,
    timestamp,
    payload,
  });

  it("projects query events deterministically and skips unrelated or incomplete ones", () => {
    const envelopes: EventEnvelope[] = [
      envelope(1, "2026-08-30T00:00:01.000Z", {
        type: "operation_started",
        operation_id: "tool:pubmed:query:1",
        label: "检索 PubMed",
        category: "discovery",
        attempt: 1,
      }),
      envelope(2, "2026-08-30T00:00:02.000Z", {
        type: "operation_progress",
        operation_id: "tool:pubmed:query:1",
        kind: "query",
        current: 7,
        total: null,
        detail: { source: "pubmed", status: "success", query: "egfr" },
      }),
      envelope(3, "2026-08-30T00:00:03.000Z", {
        type: "operation_progress",
        operation_id: "tool:geo:download:1",
        kind: "downloaded_bytes",
        current: 512,
        detail: { source: "geo" },
      }),
      envelope(4, "2026-08-30T00:00:04.000Z", {
        type: "operation_progress",
        operation_id: "tool:chembl:query:1",
        kind: "query",
        current: 0,
        detail: { source: "chembl", status: "unexpected_status" },
      }),
    ];
    const first = projectDiscoveryQueries(envelopes);
    expect(first).toEqual([
      {
        operation_id: "tool:pubmed:query:1",
        source: "pubmed",
        query: "egfr",
        status: "success",
        result_count: 7,
        requested_limit: null,
        retrieved_at: "2026-08-30T00:00:02.000Z",
      },
    ]);
    expect(projectDiscoveryQueries(envelopes)).toEqual(first);
  });

  it("rebuilds a ledger equivalent to the runtime hook accumulation", () => {
    // The hooks capture (operation_id, source, query, status, result_count)
    // verbatim; the projector rebuilds the same fields from persisted events
    // with retrieved_at taken from the envelope timestamp.
    const events: EventEnvelope[] = [
      envelope(1, "2026-08-30T01:00:00.000Z", {
        type: "operation_progress",
        operation_id: "tool:gwas:query:3",
        kind: "query",
        current: 89,
        detail: { source: "gwas_catalog", status: "page_fallback", query: "bellenguez" },
      }),
    ];
    const rebuilt = projectDiscoveryQueries(events);
    const captured: DiscoveryQueryRecord[] = [{
      operation_id: "tool:gwas:query:3",
      source: "gwas_catalog",
      query: "bellenguez",
      status: "page_fallback",
      result_count: 89,
      requested_limit: null,
      retrieved_at: rebuilt[0]?.retrieved_at ?? "",
    }];
    expect(rebuilt[0]).toEqual(captured[0]);
    expect(rebuilt[0]).toEqual(expect.objectContaining({
      operation_id: "tool:gwas:query:3",
      source: "gwas_catalog",
      status: "page_fallback",
      result_count: 89,
    }));
  });
});

describe("registered multitable publication carries the coverage artifact", () => {
  it("publishes source_coverage_report.json as an audit_report with matching sha256", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "coverage-e2e-"));
    tempRoots.push(taskRoot);
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    // Register carriers first, then rewrite the document to reference them, and
    // register the rewritten document last (receipt must match written bytes).
    const carrierAPath = "source_assets/paper.json";
    const carrierBPath = "source_assets/pubmed.json";
    await writeFile(path.join(taskRoot, carrierAPath), "paper carrier bytes\n");
    await writeFile(path.join(taskRoot, carrierBPath), "pubmed carrier bytes\n");
    const assetRegistry = new SourceAssetRegistry("task_coverage_e2e", taskRoot);
    const carrierA = await assetRegistry.register({ sourceId: "source_paper_carrier", relativePath: carrierAPath });
    const carrierB = await assetRegistry.register({ sourceId: "source_pubmed_carrier", relativePath: carrierBPath });
    const document = JSON.parse(await readFile(path.join(FIXTURES, "non-gold.valid.json"), "utf8")) as {
      sources: Array<{ source_asset_id: string; source_locator: { asset_id: string } }>;
    };
    document.sources[0]!.source_asset_id = carrierA.asset_ref.asset_id;
    document.sources[0]!.source_locator.asset_id = carrierA.asset_ref.asset_id;
    document.sources[1]!.source_asset_id = carrierB.asset_ref.asset_id;
    document.sources[1]!.source_locator.asset_id = carrierB.asset_ref.asset_id;
    const carrierPath = "source_assets/non-gold.valid.json";
    await writeFile(path.join(taskRoot, carrierPath), `${JSON.stringify(document)}\n`);
    const receipt = await assetRegistry.register({
      sourceId: "source_coverage_fixture",
      relativePath: carrierPath,
    });

    const bindings = literatureEvidenceAdapterRegistrations.map((registration, index) => ({
      schema_version: "1.0" as const,
      binding_id: `literature_${index}`,
      source: `registered_literature_${literatureEvidenceTables[index]!.definition.table_id}`,
      acquisition: {
        schema_version: "1.0" as const,
        mode: "builtin" as const,
        provider_id: "registered_asset",
        recipe_id: null,
        recipe_version: null,
      },
      adapter_id: registration.parser.adapter_id,
      accession: null,
      parameters: {},
    }));
    const discoveryQueries = [
      discoveryRecord("tool:pubmed:query:1", "success"),
      discoveryRecord("tool:pubmed:query:2", "failed"),
    ];
    const result = await executeRegisteredMultiTableBuild({
      taskId: "task_coverage_e2e",
      runId: "run_coverage",
      taskRoot,
      spec: {
        schema_version: "1.0",
        requirement_id: "build_coverage",
        objective: "Publish literature evidence with coverage evidence",
        dataset_family: LITERATURE_EVIDENCE_FAMILY_ID,
        row_granularity: LITERATURE_EVIDENCE_ROW_GRANULARITY,
        entities: {},
        cohort_filters: {},
        required_fields: literatureEvidenceTables[0]!.schema.fields.map((field) => field.name),
        schema_ref: literatureEvidenceTables[0]!.schema.schema_id,
        source_bindings: bindings,
        normalization_profile_ref: "literature_evidence.registered.v1",
        merge_strategy: "registered_multitable_identity",
        validation_profile_ref: "literature_evidence.release.v1",
        output_format: "csv",
        target_entity_level: null,
      },
      registeredAssetIds: Object.fromEntries(
        bindings.map((binding) => [binding.binding_id, receipt.asset_ref.asset_id]),
      ),
      publishedAt: "2026-08-30T00:00:00.000Z",
      discoveryQueries,
    });
    expect(result.validation.status).toBe("passed");

    const entry = result.manifest.artifacts.find(
      (artifact) => artifact.role === "audit_report" && artifact.relative_path.endsWith(SOURCE_COVERAGE_ARTIFACT_FILE),
    );
    expect(entry).toBeDefined();
    const artifactPath = path.join(
      taskRoot,
      "dataset_runs",
      "run_coverage",
      "build_coverage",
      result.publication.versionDir,
      entry!.relative_path,
    );
    const bytes = await readFile(artifactPath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry!.sha256);

    const report = JSON.parse(bytes.toString("utf8")) as {
      universe_scope: string;
      query_plan: unknown[];
      acquisition_coverage: Array<{ status: string }>;
      discovery_queries: Array<{ status: string }>;
      summary: { discovery_total: number; discovery_failed: number };
    };
    expect(report.universe_scope).toBe("spec_source_bindings");
    expect(report.query_plan).toHaveLength(bindings.length);
    expect(report.acquisition_coverage).toHaveLength(bindings.length);
    expect(report.discovery_queries).toHaveLength(2);
    expect(report.summary).toMatchObject({ discovery_total: 2, discovery_failed: 1 });
  });
});
