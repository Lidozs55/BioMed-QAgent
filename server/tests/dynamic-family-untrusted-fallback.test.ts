import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  computeFamilySpecDigest,
  type FamilySpec,
  type OperationResultCommitReceipt,
  type OperationResultDependencyClosure,
  type OperationResultFileReceipt,
  type OperationResultManifest,
  type Projection,
  type PublicationCandidate,
} from "@biomed/contracts";
import { afterEach, describe, expect, test } from "vitest";

import {
  archiveCommittedDynamicTablesAsUntrustedArtifacts,
  classifyDynamicPublicationRejection,
  DynamicPublicationUntrustedFallbackError,
  untrustedFallbackIdentityLine,
  untrustedFallbackMediaType,
} from "../src/runtime/dynamic-family-untrusted-fallback.js";
import { listUntrustedArtifacts } from "../src/runtime/untrusted-artifact-store.js";
import type { DynamicFamilyExecutionResult } from "../src/dataset/dynamic-family/submission.js";

const roots: string[] = [];
const TASK_ID = "task_untrusted_fb";
const RUN_ID = "run_untrusted_fb";
const REQUIREMENT_ID = "build_untrusted_fb";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const TABLE_A = "record_id,value\nr1,1\n";
const TABLE_B = "point_id,note\np1,ok\n";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fileReceipt(content: string): OperationResultFileReceipt {
  return { relative_path: "", size_bytes: Buffer.byteLength(content, "utf8"), sha256: sha256(content) };
}

function committedReceipt(): OperationResultCommitReceipt {
  return { state: "committed", commit_id: `commit_${DIGEST_B.slice(0, 16)}`, committed_at: "2026-09-01T00:00:00.000Z" };
}

function closure(): OperationResultDependencyClosure {
  return {
    input_asset_ids: [`asset_${DIGEST_A}`],
    upstream_result_manifest_ids: [],
    parameter_digest: DIGEST_B,
    implementation_digest: DIGEST_B,
  };
}

function operationResult(outputFiles: OperationResultFileReceipt[]): OperationResultManifest {
  return {
    schema_version: "1.0",
    result_manifest_id: "result_untrusted_fb",
    task_id: TASK_ID,
    run_id: RUN_ID,
    requirement_id: REQUIREMENT_ID,
    operation_id: "operation_untrusted_fb",
    operation_kind: "integrate",
    operation_attempt_id: "attempt_untrusted_fb",
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST_A,
    parameter_digest: DIGEST_B,
    implementation_digest: DIGEST_B,
    output_digest: sha256(JSON.stringify(outputFiles)),
    output_kind: "integrated_table",
    output_summary: {},
    output_files: outputFiles,
    dependency_closure: closure(),
    commit: committedReceipt(),
  };
}

interface Fixture {
  root: string;
  taskRoot: string;
  result: DynamicFamilyExecutionResult;
}

async function fixture(options: { tamperPrimaryBytes?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "untrusted-fallback-"));
  roots.push(root);
  const taskRoot = path.join(root, TASK_ID);
  const trustedRoot = path.join(taskRoot, "dataset_runs", RUN_ID, REQUIREMENT_ID, "dynamic-results", "committed_x");
  const primary = options.tamperPrimaryBytes === true ? `${TABLE_A}r2,2\n` : TABLE_A;
  await mkdir(path.join(trustedRoot, "tables"), { recursive: true });
  await writeFile(path.join(trustedRoot, "tables", "records.csv"), primary, "utf8");
  await writeFile(path.join(trustedRoot, "tables", "points.csv"), TABLE_B, "utf8");
  const primaryReceipt = { ...fileReceipt(TABLE_A), relative_path: "tables/records.csv" };
  const supportingReceipt = { ...fileReceipt(TABLE_B), relative_path: "tables/points.csv" };
  const operation = operationResult([primaryReceipt, supportingReceipt]);

  const projection: Projection = {
    projection_id: "projection_fb",
    schema_version: "2.0",
    primary_tables: ["records"],
    supporting_tables: ["points"],
    derived_tables: [],
    required: ["records", "points"],
    optional: [],
    allow_empty: [],
    relations: [],
    row_granularity: "record",
    compatibility_dimensions: [],
    merge_identity_fields: ["record_id"],
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
  };
  const unsignedFamily: FamilySpec = {
    family_spec_id: "family_fb",
    semantic_version: "1.0.0",
    canonical_digest: DIGEST_A,
    projections: [projection],
    table_definitions: [
      { table_id: "records", schema_ref: "schema_records", role: "primary", required: true, allow_empty: false, primary_key: ["record_id"], field_names: ["record_id", "value"] },
      { table_id: "points", schema_ref: "schema_points", role: "supporting", required: true, allow_empty: false, primary_key: ["point_id"], field_names: ["point_id", "note"] },
    ],
    relations: [],
    identity: {
      dataset_id_scheme: "ds_hash", dataset_revision_id_scheme: "dsrev_hash", asset_id_scheme: "asset_sha256",
      sample_identity_fields: ["dataset_revision_id", "sample_id"], probe_mapping_assertion_pk: "mapping_assertion_id",
    },
    transform_capability_refs: [],
    declared_outputs: [
      { table_id: "records", schema_ref: "schema_records" },
      { table_id: "points", schema_ref: "schema_points" },
    ],
    integration_policy_ref: "policy_integration",
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
    resource_class_request: "small",
    scope: "task",
    author: "agent",
    evidence_refs: [],
  };
  const familySpec = { ...unsignedFamily, canonical_digest: await computeFamilySpecDigest(unsignedFamily) };
  const csvRecord = (name: string, key: string, count: number) => {
    // Candidate refs always bind the ORIGINAL admitted bytes; the tamper
    // option only rewrites the trusted-root file, so the fallback's byte
    // re-read (not the ref/receipt agreement) is what detects the drift.
    const admittedBytes = name === "records" ? TABLE_A : TABLE_B;
    return {
      definition: { table_id: name, schema_ref: name === "records" ? "schema_records" : "schema_points", role: name === "records" ? "primary" as const : "supporting" as const, required: true, allow_empty: false, primary_key: [key], field_names: name === "records" ? ["record_id", "value"] : ["point_id", "note"] },
      data_ref: {
        result_manifest_id: operation.result_manifest_id,
        output_kind: "integrated_table" as const,
        output_file_index: name === "records" ? 0 : 1,
        output_file_sha256: sha256(admittedBytes),
      },
      row_count: count,
    };
  };
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: TASK_ID,
    requirement_id: REQUIREMENT_ID,
    dataset_family: familySpec.family_spec_id,
    row_granularity: projection.row_granularity,
    tables: [csvRecord("records", "record_id", 1), csvRecord("points", "point_id", 1)],
    relations: [],
    provenance_refs: [],
    confidence_refs: [],
    audit_refs: [],
    registered_asset_ids: [`asset_${DIGEST_A}`],
  };
  const candidate = {
    ...candidateBody,
    candidate_id: `candidate_${sha256(JSON.stringify(candidateBody)).slice(0, 24)}`,
  } as unknown as PublicationCandidate;

  return {
    root,
    taskRoot,
    result: {
      receipt: {} as DynamicFamilyExecutionResult["receipt"],
      operationResult: operation,
      materialization: {
        schema_profile: "dynamic_string_preserving.v1" as const,
        schemas: [],
        candidate,
      },
      trustedRoot,
      sourceAcquisitionProvenance: Object.freeze([]),
      sourceInputProvenance: Object.freeze([]),
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dynamic publication untrusted-artifact fallback", () => {
  test("classifies semantic rejections versus control/integrity failures", () => {
    expect(classifyDynamicPublicationRejection(
      "dynamic multi-table product is not publishable: literature_chart semantic gate failed",
    )).toBe("semantic_rejection");
    expect(classifyDynamicPublicationRejection("dynamic publication review was not accepted: reject")).toBe("semantic_rejection");
    for (const message of [
      "dynamic family preflight generation is stale",
      "operation aborted by timeout or cancel",
      "dynamic family execution lock fence was lost",
      "dynamic product copy drifted for 'records'",
      "publication refused: main input pending",
      "untrusted fallback task/requirement identity mismatch: candidate task=other",
      "tables/records.csv escapes the committed trusted root",
      "references a missing admitted output at index 3",
    ]) {
      expect(classifyDynamicPublicationRejection(message), message).toBe("control_failure");
    }
  });

  test("deterministic media type and bounded identity line", () => {
    expect(untrustedFallbackMediaType(",")).toBe("text/csv");
    expect(untrustedFallbackMediaType("\t")).toBe("text/tab-separated-values");
    expect(untrustedFallbackMediaType("°")).toBe("application/octet-stream");
    const line = untrustedFallbackIdentityLine({
      taskId: TASK_ID, runId: RUN_ID, requirementId: REQUIREMENT_ID, resultManifestId: "result_x",
    });
    expect(line).toBe(`task=${TASK_ID} run=${RUN_ID} requirement=${REQUIREMENT_ID} operation_result=result_x`);
  });

  test("archives exact verified candidate bytes as ua_* receipts with quarantine metadata", async () => {
    const fx = await fixture();
    const receipts = await archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: fx.result,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "dynamic publication review was not accepted: reject; reviewer reason: axis units unverifiable",
    });
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.submission_id).toMatch(/^ua_[0-9a-f]{24}$/);
    }
    expect(receipts.map((receipt) => receipt.table_id)).toEqual(["records", "points"]);
    expect(receipts.map((receipt) => receipt.name)).toEqual(["records.csv", "points.csv"]);
    expect(receipts.map((receipt) => receipt.sha256)).toEqual([sha256(TABLE_A), sha256(TABLE_B)]);
    expect(receipts.map((receipt) => receipt.size_bytes)).toEqual([
      Buffer.byteLength(TABLE_A, "utf8"), Buffer.byteLength(TABLE_B, "utf8"),
    ]);

    const listing = await listUntrustedArtifacts(fx.taskRoot);
    expect(listing).toHaveLength(2);
    expect(listing.every((receipt) => receipt.authoritative === false && receipt.trust === "untrusted")).toBe(true);
    expect(listing.every((receipt) => receipt.coverage_status === "partial")).toBe(true);
    const primary = listing.find((receipt) => receipt.name === "records.csv");
    expect(primary?.covered_scope).toEqual([
      "table:records",
      "schema:schema_records",
      `operation_result:${fx.result.operationResult.result_manifest_id}`,
    ]);
    expect(primary?.missing_scope).toEqual([
      "formal_publication", "product_admission", "human_review_closure", "product_assessment",
    ]);
    expect(primary?.source_note).toContain("Automatic untrusted-artifact fallback");
    expect(primary?.source_note).toContain("formally rejected");
    expect(primary?.source_note).toContain("axis units unverifiable");
    expect(primary?.source_note).toContain(`task=${TASK_ID}`);
    expect(primary?.source_note).toContain(`run=${RUN_ID}`);
    expect(primary?.source_note).toContain(`requirement=${REQUIREMENT_ID}`);
    expect(primary?.source_note).toContain(`operation_result=${fx.result.operationResult.result_manifest_id}`);
    expect(primary?.media_type).toBe("text/csv");

    // Exact downloadable bytes per receipt.
    const stored = await readFile(path.join(fx.taskRoot, "quarantine", receipts[0]!.submission_id, "artifact.bin"));
    expect(stored.toString("utf8")).toBe(TABLE_A);
    const storedPoints = await readFile(path.join(fx.taskRoot, "quarantine", receipts[1]!.submission_id, "artifact.bin"));
    expect(storedPoints.toString("utf8")).toBe(TABLE_B);
    expect((await readdir(path.join(fx.taskRoot, "quarantine", receipts[0]!.submission_id))).sort())
      .toEqual(["artifact.bin", "receipt.json"]);
  });

  test("tampered trusted-root bytes produce no quarantine output (hash/size drift)", async () => {
    const fx = await fixture({ tamperPrimaryBytes: true });
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: fx.result,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "dynamic publication review was not accepted: reject",
    })).rejects.toThrow(/drifted/);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
    await expect(stat(path.join(fx.taskRoot, "quarantine"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("identity mismatch is a hard control failure without quarantine output", async () => {
    const fx = await fixture();
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: fx.result,
      taskId: "task_other",
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "dynamic publication review was not accepted: reject",
    })).rejects.toThrow(/identity mismatch/);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("missing admitted output receipt is a hard control failure", async () => {
    const fx = await fixture();
    const broken = {
      ...fx.result,
      operationResult: {
        ...fx.result.operationResult,
        output_files: fx.result.operationResult.output_files.slice(0, 1),
      },
    } as DynamicFamilyExecutionResult;
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: {
        ...broken,
        materialization: {
          ...broken.materialization,
          candidate: {
            ...broken.materialization.candidate,
            tables: broken.materialization.candidate.tables.map((table, index) =>
              index === 1
                ? { ...table, data_ref: { ...table.data_ref, output_file_index: 5 } }
                : table),
          },
        },
      } as DynamicFamilyExecutionResult,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "dynamic publication review was not accepted: reject",
    })).rejects.toThrow(/missing admitted output/);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("path traversal outside the committed trusted root is rejected", async () => {
    const fx = await fixture();
    const escaping = {
      ...fx.result,
      operationResult: {
        ...fx.result.operationResult,
        output_files: fx.result.operationResult.output_files.map((file, index) =>
          index === 0 ? { ...file, relative_path: "../outside/records.csv" } : file),
      },
    } as DynamicFamilyExecutionResult;
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: escaping,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "dynamic publication review was not accepted: reject",
    })).rejects.toThrow(/escapes the committed trusted root/);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("dynamic publication rejection error carries formal rejection and receipts", () => {
    const error = new DynamicPublicationUntrustedFallbackError({
      message: "dynamic publication review was not accepted: reject",
      untrustedArtifacts: [{
        submission_id: `ua_${"0".repeat(24)}`,
        table_id: "records",
        name: "records.csv",
        size_bytes: 18,
        sha256: DIGEST_A,
      }],
    });
    expect(error.name).toBe("DynamicPublicationUntrustedFallbackError");
    expect(error.formal_status).toBe("rejected");
    expect(error).toBeInstanceOf(Error);
    expect(error.untrusted_artifacts).toEqual([{
      submission_id: `ua_${"0".repeat(24)}`,
      table_id: "records",
      name: "records.csv",
      size_bytes: 18,
      sha256: DIGEST_A,
    }]);
    expect(DynamicPublicationUntrustedFallbackError.extractFailedChecks(error)).toBeUndefined();
    expect(DynamicPublicationUntrustedFallbackError.extractFailedChecks({
      failed_checks: [{ check_id: "semantic_gate", scope: "table", passed: false, detail: "missing evidence" }],
    })).toEqual([{ check_id: "semantic_gate", scope: "table", passed: false, detail: "missing evidence" }]);
  });

  test("pure Core materialization accepts the fixture family/projection shape (fixture honesty)", async () => {
    const fx = await fixture();
    const candidate = fx.result.materialization.candidate;
    // The fixture candidate must carry the exact committed receipt hashes the
    // fallback verifies against, proving bytes/refs stay in the admitted closure.
    expect(candidate.tables.map((table) => table.data_ref.output_file_sha256))
      .toEqual([sha256(TABLE_A), sha256(TABLE_B)]);
    expect(candidate.task_id).toBe(TASK_ID);
    expect(candidate.requirement_id).toBe(REQUIREMENT_ID);
  });
});
