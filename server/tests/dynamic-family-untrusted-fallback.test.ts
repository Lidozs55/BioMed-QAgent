import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";import { tmpdir } from "node:os";
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
  type UntrustedArtifactMetadata,
} from "@biomed/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  archiveCommittedDynamicTablesAsUntrustedArtifacts,
  untrustedFallbackIdentityLine,
  untrustedFallbackMediaType,
} from "../src/runtime/dynamic-family-untrusted-fallback.js";
import {
  LiteratureProfileRejectionError,
  DynamicProductNotPublishableError,
  PublicationAcceptanceRejectedError,
} from "../src/dataset/dynamic-family/formal-rejections.js";
import { listUntrustedArtifacts, storeUntrustedArtifact } from "../src/runtime/untrusted-artifact-store.js";
import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import type { DynamicFamilyExecutionResult } from "../src/dataset/dynamic-family/submission.js";

/**
 * Deterministic storage-failure hook: when set, ``storeUntrustedArtifact``
 * (as imported by the helper) delegates to this function. Defaults to the
 * real store, so every other test exercises the genuine path.
 */
let storeUntrustedHook: typeof storeUntrustedArtifact | null = null;

vi.mock("../src/runtime/untrusted-artifact-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/untrusted-artifact-store.js")>();
  return {
    ...actual,
    storeUntrustedArtifact: (taskRoot: string, taskId: string, metadata: UntrustedArtifactMetadata, bytes: Buffer) =>
      storeUntrustedHook !== null
        ? storeUntrustedHook(taskRoot, taskId, metadata, bytes)
        : actual.storeUntrustedArtifact(taskRoot, taskId, metadata, bytes),
  };
});

const roots: string[] = [];
const TASK_ID = "task_untrusted_fb";
const RUN_ID = "run_untrusted_fb";
const REQUIREMENT_ID = "build_untrusted_fb";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const TABLE_A = "record_id,value\nr1,1\n";
const TABLE_B = "point_id,note\np1,ok\n";

async function actualStoreUntrustedArtifact(
  ...args: Parameters<typeof storeUntrustedArtifact>
): Promise<Awaited<ReturnType<typeof storeUntrustedArtifact>>> {
  const actual = await vi.importActual<typeof import("../src/runtime/untrusted-artifact-store.js")>(
    "../src/runtime/untrusted-artifact-store.js",
  );
  return actual.storeUntrustedArtifact(...args);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function refreshCandidateId(candidate: PublicationCandidate): void {
  const body = structuredClone(candidate) as unknown as Record<string, unknown>;
  delete body.candidate_id;
  candidate.candidate_id = `candidate_${canonicalDigest(body).slice(0, 32)}`;
}

function fileReceipt(content: string): OperationResultFileReceipt {
  return { relative_path: "", size_bytes: Buffer.byteLength(content, "utf8"), sha256: sha256(content) };
}

function committedReceipt(resultManifestId: string): OperationResultCommitReceipt {
  const committedAt = "2026-09-01T00:00:00.000Z";
  return {
    state: "committed",
    commit_id: canonicalDigest({ result_manifest_id: resultManifestId, committed_at: committedAt }),
    committed_at: committedAt,
  };
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
  const operationId = "operation_untrusted_fb";
  const operationAttemptId = "attempt_untrusted_fb";
  const resultManifestId = canonicalDigest({
    task_id: TASK_ID,
    run_id: RUN_ID,
    requirement_id: REQUIREMENT_ID,
    operation_id: operationId,
    operation_attempt_id: operationAttemptId,
  });
  return {
    schema_version: "1.0",
    result_manifest_id: resultManifestId,
    task_id: TASK_ID,
    run_id: RUN_ID,
    requirement_id: REQUIREMENT_ID,
    operation_id: operationId,
    operation_kind: "integrate",
    operation_attempt_id: operationAttemptId,
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST_A,
    parameter_digest: DIGEST_B,
    implementation_digest: DIGEST_B,
    output_digest: canonicalDigest(outputFiles),
    output_kind: "integrated_table",
    output_summary: {
      tables: {
        records: {
          table_id: "records",
          dataset_family: "family_fb",
          row_granularity: "record",
          schema_ref: "schema_records",
          row_count: 1,
          column_count: 2,
          primary_file_sha256: sha256(TABLE_A),
        },
        points: {
          table_id: "points",
          dataset_family: "family_fb",
          row_granularity: "record",
          schema_ref: "schema_points",
          row_count: 1,
          column_count: 2,
          primary_file_sha256: sha256(TABLE_B),
        },
      },
    },
    output_files: outputFiles,
    dependency_closure: closure(),
    commit: committedReceipt(resultManifestId),
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
  const primaryReceipt = { ...fileReceipt(TABLE_A), relative_path: "tables/records.csv" };
  const supportingReceipt = { ...fileReceipt(TABLE_B), relative_path: "tables/points.csv" };
  const operation = operationResult([primaryReceipt, supportingReceipt]);
  const trustedRoot = path.join(
    taskRoot,
    "dataset_runs",
    RUN_ID,
    REQUIREMENT_ID,
    "dynamic-results",
    `transform-quarantine-${operation.output_digest!.slice(0, 24)}-00000000-0000-4000-8000-000000000000`,
  );
  const primary = options.tamperPrimaryBytes === true ? `${TABLE_A}r2,2\n` : TABLE_A;
  await mkdir(path.join(trustedRoot, "tables"), { recursive: true });
  await writeFile(path.join(trustedRoot, "tables", "records.csv"), primary, "utf8");
  await writeFile(path.join(trustedRoot, "tables", "points.csv"), TABLE_B, "utf8");

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
    candidate_id: `candidate_${canonicalDigest(candidateBody).slice(0, 32)}`,
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
  test("media type is deterministic by delimiter", () => {
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
    expect(receipts.every((receipt) =>
      receipt.authoritative === false && receipt.trust === "untrusted"
      && receipt.media_type === "text/csv"
    )).toBe(true);

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
      "formal_publication", "formal_artifact",
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
    })).rejects.toThrow(/size .* does not match the admitted receipt/);
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
    })).rejects.toThrow(/identity mismatch|different task|invalid committed candidate\/result/i);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("operation and candidate identity, manifest, asset, and summary mismatches are hard failures", async () => {
    const fx = await fixture();
    const candidateIdentityMismatch = structuredClone(fx.result) as DynamicFamilyExecutionResult;
    candidateIdentityMismatch.materialization.candidate.candidate_id = "candidate_forged";
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: candidateIdentityMismatch,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic closure failed",
    })).rejects.toThrow(/candidate identity digest/i);

    const resultIdentityMismatch = structuredClone(fx.result) as DynamicFamilyExecutionResult;
    resultIdentityMismatch.operationResult.result_manifest_id = "result_forged";
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: resultIdentityMismatch,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic closure failed",
    })).rejects.toThrow(/operation result identity digest/i);

    const assetMismatch = structuredClone(fx.result) as DynamicFamilyExecutionResult;
    assetMismatch.materialization.candidate.registered_asset_ids = [`asset_${DIGEST_B}`];
    refreshCandidateId(assetMismatch.materialization.candidate);
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: assetMismatch,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic closure failed",
    })).rejects.toThrow(/outputs and assets/i);

    const runMismatch = {
      ...fx.result,
      operationResult: { ...fx.result.operationResult, run_id: "run_other" },
    } as DynamicFamilyExecutionResult;
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: runMismatch,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic closure failed",
    })).rejects.toThrow(/different run|invalid committed candidate\/result|identity mismatch/i);

    const wrongManifest = {
      ...fx.result,
      materialization: {
        ...fx.result.materialization,
        candidate: {
          ...fx.result.materialization.candidate,
          tables: fx.result.materialization.candidate.tables.map((table, index) =>
            index === 0
              ? { ...table, data_ref: { ...table.data_ref, result_manifest_id: "result_other" } }
              : table),
        },
      },
    } as DynamicFamilyExecutionResult;
    refreshCandidateId(wrongManifest.materialization.candidate);
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: wrongManifest,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic closure failed",
    })).rejects.toThrow(/different operation result/i);

    const summaryDrift = structuredClone(fx.result) as DynamicFamilyExecutionResult;
    const summaries = summaryDrift.operationResult.output_summary.tables as Record<string, Record<string, unknown>>;
    summaries.records!.row_count = 2;
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: summaryDrift,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic closure failed",
    })).rejects.toThrow(/operation summary/i);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("trusted-root and execution-fence mismatches never leave quarantine output", async () => {
    const fx = await fixture();
    const outsideRoot = path.join(fx.taskRoot, "outside-committed");
    await mkdir(outsideRoot);
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: { ...fx.result, trustedRoot: outsideRoot },
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic closure failed",
    })).rejects.toThrow(/not the canonical Core-committed/i);

    const aborted = new AbortController();
    aborted.abort();
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: fx.result,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic closure failed",
      signal: aborted.signal,
    })).rejects.toThrow(/cancelled/i);

    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: fx.result,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic closure failed",
      isExecutionCurrent: () => false,
    })).rejects.toThrow(/stale/i);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("mid-storage fence loss removes only receipts created by this fallback", async () => {
    const fx = await fixture();
    let current = true;
    let stores = 0;
    storeUntrustedHook = async (taskRoot, taskId, metadata, bytes) => {
      stores += 1;
      const receipt = await actualStoreUntrustedArtifact(taskRoot, taskId, metadata, bytes);
      current = false;
      return receipt;
    };
    try {
      await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
        result: fx.result,
        taskId: TASK_ID,
        taskRoot: fx.taskRoot,
        runId: RUN_ID,
        requirementId: REQUIREMENT_ID,
        rejectionReason: "semantic closure failed",
        isExecutionCurrent: () => current,
      })).rejects.toThrow(/stale/i);
    } finally {
      storeUntrustedHook = null;
    }
    expect(stores).toBe(1);
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
      materialization: {
        ...fx.result.materialization,
        candidate: {
          ...fx.result.materialization.candidate,
          tables: fx.result.materialization.candidate.tables.map((table, index) =>
            index === 1
              ? { ...table, data_ref: { ...table.data_ref, output_file_index: 5 } }
              : table),
        },
      },
    } as DynamicFamilyExecutionResult;
    refreshCandidateId(broken.materialization.candidate);
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: broken,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "dynamic publication review was not accepted: reject",
    })).rejects.toThrow(/missing admitted output|does? not exactly close/i);
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
    })).rejects.toThrow(/canonical relative path|escape its root|escapes the committed trusted root/i);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("formal rejection preserves identity while carrying verified untrusted receipts", () => {
    const error = new PublicationAcceptanceRejectedError("reject", "axis units unverifiable");
    error.attachUntrustedArtifacts([{
      submission_id: `ua_${"0".repeat(24)}`,
      table_id: "records",
      name: "records.csv",
      media_type: "text/csv",
      size_bytes: 18,
      sha256: DIGEST_A,
      authoritative: false,
      trust: "untrusted",
    }]);
    expect(error.name).toBe("PublicationAcceptanceRejectedError");
    expect(error.formal_status).toBe("rejected");
    expect(error.message).toContain("reviewer reason: axis units unverifiable");
    expect(error.untrusted_artifacts).toEqual([{
      submission_id: `ua_${"0".repeat(24)}`,
      table_id: "records",
      name: "records.csv",
      media_type: "text/csv",
      size_bytes: 18,
      sha256: DIGEST_A,
      authoritative: false,
      trust: "untrusted",
    }]);
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

  test("allows exactly the three typed formal rejections through the archive gate", async () => {
    const fx = await fixture();
    const call = () => archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: fx.result,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "semantic profile closure failed",
      failedChecks: [{ check_id: "semantic_gate", scope: "profile", passed: false, detail: "missing evidence" }],
    });
    // Sanity: the helper itself archives when the caller selects an
    // allowlisted rejection.
    await expect(call()).resolves.toHaveLength(2);

    // The typed classes are Error subclasses carrying stable shape.
    const literature = new LiteratureProfileRejectionError("semantic profile failed");
    const notPublishable = new DynamicProductNotPublishableError(
      "dynamic multi-table product is not publishable: profile:semantic_gate (missing evidence)",
      [{ check_id: "semantic_gate", scope: "profile", passed: false, detail: "missing evidence" }],
    );
    const acceptance = new PublicationAcceptanceRejectedError("reject", "axis units unverifiable");
    expect(literature.reason).toBe("semantic profile failed");
    expect(notPublishable.failedChecks).toHaveLength(1);
    expect(acceptance.action).toBe("reject");
    expect(acceptance.reason).toBe("axis units unverifiable");
    expect(acceptance.message).toContain("reviewer reason: axis units unverifiable");
    expect(new PublicationAcceptanceRejectedError("skip", null).message).toContain("skip");
  });

  test("filesystem I/O error during verification propagates unchanged and leaves zero quarantine output", async () => {
    const fx = await fixture();
    // Remove one admitted table file: the verification read must surface the
    // raw filesystem error (or the integrity equivalent), never archive.
    await rm(path.join(fx.result.trustedRoot, "tables", "points.csv"));
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: fx.result,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "dynamic publication review was not accepted: reject",
    })).rejects.toThrow();
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("hardlinked admitted table is rejected before any quarantine write", async () => {
    const fx = await fixture();
    const admittedPath = path.join(fx.result.trustedRoot, "tables", "records.csv");
    const hardlinkPath = path.join(fx.root, "records-hardlink.csv");
    await link(admittedPath, hardlinkPath);
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: fx.result,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "dynamic publication review was not accepted: reject",
    })).rejects.toThrow(/independent regular file|hardlink/i);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("symlinked committed-root child is rejected before any quarantine write", async () => {
    const fx = await fixture();
    // Replace the records.csv file with a symlink to the real bytes stored
    // outside the committed root.
    await rm(path.join(fx.result.trustedRoot, "tables", "records.csv"));
    const outside = path.join(fx.root, "outside-records.csv");
    await writeFile(outside, TABLE_A, "utf8");
    await symlink(outside, path.join(fx.result.trustedRoot, "tables", "records.csv"));
    await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
      result: fx.result,
      taskId: TASK_ID,
      taskRoot: fx.taskRoot,
      runId: RUN_ID,
      requirementId: REQUIREMENT_ID,
      rejectionReason: "dynamic publication review was not accepted: reject",
    })).rejects.toThrow(/independent regular file|symlink/i);
    await expect(listUntrustedArtifacts(fx.taskRoot)).resolves.toEqual([]);
  });

  test("storage failure on table k removes only this invocation's receipts, never pre-existing submissions", async () => {
    const fx = await fixture();
    // A pre-existing manual submission that must survive any cleanup.
    const manual = await storeUntrustedArtifact(
      fx.taskRoot,
      TASK_ID,
      {
        schema_version: "1.0",
        name: "manual_note.csv",
        media_type: "text/csv",
        source_note: null,
        coverage_status: "unknown",
        covered_scope: [],
        missing_scope: [],
      },
      Buffer.from("manual,upload\n1,2\n", "utf8"),
    );
    let storageCalls = 0;
    storeUntrustedHook = async (taskRoot, taskId, metadata, bytes) => {
      storageCalls += 1;
      if (storageCalls === 2) throw new Error("simulated storage failure (ENOSPC)");
      return actualStoreUntrustedArtifact(taskRoot, taskId, metadata, bytes);
    };
    try {
      await expect(archiveCommittedDynamicTablesAsUntrustedArtifacts({
        result: fx.result,
        taskId: TASK_ID,
        taskRoot: fx.taskRoot,
        runId: RUN_ID,
        requirementId: REQUIREMENT_ID,
        rejectionReason: "dynamic publication review was not accepted: reject",
      })).rejects.toThrow(/simulated storage failure/);
    } finally {
      storeUntrustedHook = null;
    }
    expect(storageCalls).toBe(2);
    // Only the manual submission survives: both invocation-created receipts
    // (table 1 stored, table 2 failed) are gone after bounded cleanup.
    const finalListing = await listUntrustedArtifacts(fx.taskRoot);
    expect(finalListing.map((receipt) => receipt.submission_id)).toEqual([manual.submission_id]);
  });
});

describe("submit_dynamic_family_publication fallback receipt projection", () => {
  test("projects formal_status and untrusted_artifacts while remaining an error", async () => {
    const { createDynamicFamilyPublicationTool } = await import("../src/agent/tools/dynamic-family-publication.js");
    const contracts = await import("@biomed/contracts");
    const typedRejection = new PublicationAcceptanceRejectedError("reject", null);
    typedRejection.attachUntrustedArtifacts([{
      submission_id: `ua_${"1".repeat(24)}`,
      table_id: "records",
      name: "records.csv",
      media_type: "text/csv",
      size_bytes: 18,
      sha256: DIGEST_A,
      authoritative: false,
      trust: "untrusted",
    }]);
    const unsignedReceipt = {
      schema_version: "1.0",
      task_id: "task_projection",
      requirement_id: "build_projection",
      generation: 0,
      family_spec_digest: DIGEST_A,
      projection_digest: DIGEST_B,
      product_requirement_digest: DIGEST_A,
      host_descriptor_digest: DIGEST_B,
      submission_digest: DIGEST_A,
      required_input_roles: ["source"],
      output_closure: ["records"],
      topology_diagnostics: [],
      acquisition_plan: [],
      receipt_digest: "0".repeat(64),
    } as unknown as Parameters<typeof contracts.computeDynamicFamilyPreflightReceiptDigest>[0];
    const preflightReceipt = {
      ...unsignedReceipt,
      receipt_digest: await contracts.computeDynamicFamilyPreflightReceiptDigest(unsignedReceipt),
    };
    const tool = createDynamicFamilyPublicationTool({
      // Receipt-only submit requires resolveSubmission; provide it so the
      // request parses and reaches the (throwing) submit seam.
      resolveSubmission: async () => {
        throw typedRejection;
      },
      submit: async () => {
        throw typedRejection;
      },
    });
    const result = await tool.execute({ schema_version: "1.0", preflight_receipt: preflightReceipt });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content) as {
      ok: boolean;
      error: {
        code: string;
        message: string;
        formal_status: string;
        untrusted_artifacts: Array<{ submission_id: string; sha256: string }>;
      };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("dynamic_publication_rejected");
    expect(body.error.message).toBe("dynamic publication review was not accepted: reject");
    expect(body.error.formal_status).toBe("rejected");
    expect(body.error.untrusted_artifacts).toEqual([{
      submission_id: `ua_${"1".repeat(24)}`,
      table_id: "records",
      name: "records.csv",
      media_type: "text/csv",
      size_bytes: 18,
      sha256: DIGEST_A,
      authoritative: false,
      trust: "untrusted",
    }]);
  });

  test("projects fallback failure on the original formal rejection without receipts", async () => {
    const { createDynamicFamilyPublicationTool } = await import("../src/agent/tools/dynamic-family-publication.js");
    const contracts = await import("@biomed/contracts");
    const rejection = new LiteratureProfileRejectionError("semantic closure failed");
    rejection.recordFallbackFailure("untrusted artifact fallback failed: integrity drift");
    const unsignedReceipt = {
      schema_version: "1.0",
      task_id: "task_projection_failure",
      requirement_id: "build_projection_failure",
      generation: 0,
      family_spec_digest: DIGEST_A,
      projection_digest: DIGEST_B,
      product_requirement_digest: DIGEST_A,
      host_descriptor_digest: DIGEST_B,
      submission_digest: DIGEST_A,
      required_input_roles: ["source"],
      output_closure: ["records"],
      topology_diagnostics: [],
      acquisition_plan: [],
      receipt_digest: "0".repeat(64),
    } as unknown as Parameters<typeof contracts.computeDynamicFamilyPreflightReceiptDigest>[0];
    const preflightReceipt = {
      ...unsignedReceipt,
      receipt_digest: await contracts.computeDynamicFamilyPreflightReceiptDigest(unsignedReceipt),
    };
    const tool = createDynamicFamilyPublicationTool({
      resolveSubmission: async () => {
        throw rejection;
      },
      submit: async () => {
        throw rejection;
      },
    });
    const result = await tool.execute({ schema_version: "1.0", preflight_receipt: preflightReceipt });
    const body = JSON.parse(result.content) as { error: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(body.error).toMatchObject({
      message: "semantic closure failed",
      formal_status: "rejected",
      fallback_failure: "untrusted artifact fallback failed: integrity drift",
    });
    expect(body.error).not.toHaveProperty("untrusted_artifacts");
  });

  test("plain publication rejections and shape-spoofed errors project without fallback properties", async () => {
    const { createDynamicFamilyPublicationTool } = await import("../src/agent/tools/dynamic-family-publication.js");
    const tool = createDynamicFamilyPublicationTool({
      submit: async () => {
        const spoofed = new Error("dynamic family preflight generation is stale") as Error & Record<string, unknown>;
        spoofed.formal_status = "rejected";
        spoofed.untrusted_artifacts = [{ submission_id: `ua_${"f".repeat(24)}` }];
        throw spoofed;
      },
    });
    const result = await tool.execute({ schema_version: "1.0", preflight_receipt: { receipt_digest: DIGEST_A } as unknown });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("dynamic_publication_rejected");
    expect(body.error).not.toHaveProperty("formal_status");
    expect(body.error).not.toHaveProperty("untrusted_artifacts");
  });
});
