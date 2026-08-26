import { describe, expect, test } from "vitest";
import type {
  OperationResultManifest,
  PublicationCandidate,
} from "@biomed/contracts";
import {
  FamilyAssemblerRegistry,
  assembleExpressionCandidate,
  createDefaultFamilyAssemblerRegistry,
} from "../src/dataset/assembly/index.js";
import { parsePublicationCandidate } from "../src/dataset/contracts/index.js";
import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";

const DIGEST = "a".repeat(64);
const ASSET_ID = `asset_${"b".repeat(64)}`;

function integrationResult(
  overrides: Partial<OperationResultManifest> = {},
): OperationResultManifest {
  const family = createDefaultDatasetFamilyRegistry().get("gene_expression");
  const schema = family.schemas[0]!;
  return {
    schema_version: "1.0",
    result_manifest_id: "result_integrate_1",
    task_id: "task_1",
    build_id: "build_1",
    operation_id: "integrate",
    operation_kind: "integrate",
    operation_attempt_id: "attempt_integrate_1",
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: DIGEST,
    output_kind: "integrated_table",
    output_summary: {
      dataset_family: "gene_expression",
      row_granularity: schema.row_granularity,
      schema_ref: schema.schema_id,
      row_count: 2,
      column_count: schema.fields.length,
      primary_file_sha256: DIGEST,
    },
    output_files: [{
      relative_path: "merged/primary.csv",
      size_bytes: 128,
      sha256: DIGEST,
    }],
    dependency_closure: {
      input_asset_ids: [ASSET_ID],
      upstream_result_manifest_ids: ["result_canonical_1"],
      parameter_digest: DIGEST,
      implementation_digest: DIGEST,
    },
    commit: {
      state: "committed",
      commit_id: "commit_integrate_1",
      committed_at: "2026-08-18T00:00:00Z",
    },
    migration: {
      mode: "native",
      legacy_checkpoint_path: null,
      migrated_at: null,
    },
    ...overrides,
  };
}

function assemble(result = integrationResult()): PublicationCandidate {
  const schema = createDefaultDatasetFamilyRegistry().get("gene_expression").schemas[0]!;
  return assembleExpressionCandidate({
    taskId: "task_1",
    buildId: "build_1",
    datasetFamily: "gene_expression",
    rowGranularity: schema.row_granularity,
    schema,
    integrationResult: result,
    registeredAssetIds: [ASSET_ID],
  });
}

describe("family publication assembly", () => {
  test("deterministically wraps an expression integration result", () => {
    const first = assemble();
    const second = assemble();

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schema_version: "1.0",
      task_id: "task_1",
      build_id: "build_1",
      dataset_family: "gene_expression",
      tables: [{
        definition: {
          table_id: "primary",
          role: "primary",
          schema_ref: "gene_expression.long.v1",
        },
        data_ref: {
          result_manifest_id: "result_integrate_1",
          output_kind: "integrated_table",
          output_file_index: 0,
          output_file_sha256: DIGEST,
        },
        row_count: 2,
      }],
      relations: [],
      registered_asset_ids: [ASSET_ID],
    });
    expect(first.candidate_id).toMatch(/^candidate_[0-9a-f]{32}$/);
    const changedRows = integrationResult({
      output_summary: {
        ...integrationResult().output_summary,
        row_count: 3,
      },
    });
    expect(assemble(changedRows).candidate_id).not.toBe(first.candidate_id);
    expect(JSON.stringify(first)).not.toContain("merged/primary.csv");
  });

  test("requires registered assets to equal the Core dependency closure", () => {
    const result = integrationResult({
      dependency_closure: {
        input_asset_ids: [],
        upstream_result_manifest_ids: ["result_canonical_1"],
        parameter_digest: DIGEST,
        implementation_digest: DIGEST,
      },
    });

    expect(() => assemble(result)).toThrow(/exactly match.*dependency closure/);
  });

  test("rejects non-integrate, cross-build, legacy and unreceipted results", () => {
    expect(() => assemble(integrationResult({ operation_kind: "canonicalize" }))).toThrow(/must be integrate/);
    expect(() => assemble(integrationResult({ build_id: "build_other" }))).toThrow(/different build/);
    expect(() => assemble(integrationResult({
      migration: {
        mode: "legacy_read_only",
        legacy_checkpoint_path: "state/integrate.json",
        migrated_at: "2026-08-18T00:00:00Z",
      },
    }))).toThrow(/must be native/);
    expect(() => assemble(integrationResult({ output_files: [] }))).toThrow(/no file receipt/);
  });

  test("rejects summary/schema mismatch and an empty required primary table", () => {
    const mismatched = integrationResult({
      output_summary: {
        ...integrationResult().output_summary,
        schema_ref: "other.schema.v1",
      },
    });
    expect(() => assemble(mismatched)).toThrow(/summary does not match/);

    const empty = integrationResult({
      output_summary: {
        ...integrationResult().output_summary,
        row_count: 0,
      },
    });
    expect(() => assemble(empty)).toThrow(/must not be empty/);
  });

  test("candidate parser rejects Agent paths and non-registered asset IDs", () => {
    const candidate = assemble();
    expect(() => parsePublicationCandidate({
      ...candidate,
      tables: [{
        ...candidate.tables[0],
        data_ref: {
          ...candidate.tables[0]!.data_ref,
          relative_path: "data/workspaces/task_1/result.csv",
        },
      }],
    })).toThrow(/unknown fields.*relative_path/);
    expect(() => parsePublicationCandidate({
      ...candidate,
      registered_asset_ids: ["data/workspaces/task_1/result.csv"],
    })).toThrow(/safe path identifier|content-addressed/);
  });

  test("does not create capability for a family without an assembler handler", () => {
    const registry = createDefaultFamilyAssemblerRegistry();
    expect(registry.list()).toEqual([
      "bioactivity_measurement",
      "gene_expression",
      "inherited_disease_gene_evidence",
      "literature_evidence",
      "protein_structure",
      "target_evidence",
      "variant_evidence",
    ]);
    expect(registry.createCapability("gene_expression").handlerId).toBe(
      "gene_expression.assembler.v1",
    );
    expect(registry.createCapability("target_evidence").handlerId).toBe("target_evidence.assembler.v1");
    const capability = registry.createCapability("gene_expression");
    const schema = createDefaultDatasetFamilyRegistry().get("gene_expression").schemas[0]!;
    expect(() => capability.assemble({
      taskId: "task_1",
      buildId: "build_1",
      datasetFamily: "target_evidence",
      rowGranularity: schema.row_granularity,
      schema,
      integrationResult: integrationResult(),
      registeredAssetIds: [ASSET_ID],
    })).toThrow(/received a different family/);

    const empty = new FamilyAssemblerRegistry();
    expect(() => empty.createCapability("gene_expression")).toThrow(/no assembler handler/);
  });
});
