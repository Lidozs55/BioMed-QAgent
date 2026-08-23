import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildTransformDescriptorDigestCanonical,
  computeFamilySpecDigest,
  computeImplementationDigest,
  type FamilySpec,
  type ImplementationDigestInput,
  type SourceLocatorV2,
  type TransformDescriptorDigestInput,
  type TransformExecutionReceipt,
} from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../adapters/identity.js";
import { parseOperationResultManifest } from "../contracts/operation-result.js";
import { admitTransformExecution } from "../transform-admission/admission.js";
import type {
  ExpectedTransformInvocation,
  TransformAdmissionRequest,
  TransformQuarantineAdmissionEvidence,
} from "../transform-admission/types.js";
import { admitOperationResultFromQuarantine, OperationResultAdmissionError } from "./admission.js";
import type {
  ExpectedOperationAdmission,
  OperationResultAdmissionInput,
} from "./types.js";

const HEX_1 = "1".repeat(64);
const HEX_2 = "2".repeat(64);
const HEX_3 = "3".repeat(64);
const HEX_4 = "4".repeat(64);
const HEX_8 = "8".repeat(64);
const HEX_9 = "9".repeat(64);
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);
const HEX_F = "f".repeat(64);

const NOW = new Date("2026-08-21T00:00:03.000Z");
const COMMITTED_AT = "2026-08-21T00:00:05.000Z";
const TABLE_BYTES = Buffer.from("sample_id,value\nS1,1\n", "utf8");
const TABLE2_BYTES = Buffer.from("sample_id,value\nS2,2\n", "utf8");
const INPUT_ASSET_ID = `asset_${HEX_F}`;
const INPUT_LOCATOR: SourceLocatorV2 = {
  locator_version: "2.0",
  locator_type: "json_pointer",
  asset_id: INPUT_ASSET_ID,
  logical_file: "source.json",
  raw_value: "S1",
  json_pointer: "/samples/0",
};

const OPERATION_OUTPUT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["acquire", "source_asset"],
  ["parse", "parsed_table"],
  ["canonicalize", "canonical_table"],
  ["compatibility_gate", "compatibility_report"],
  ["integrate", "integrated_table"],
  ["derive", "derived_evidence"],
  ["assemble", "publication_candidate"],
  ["validate_profile", "validation_result"],
  ["publish", "publication_manifest"],
];

interface OutputSeed {
  table_id: string;
  schema_ref: string;
  artifact_ref: string;
  locator_ref: string;
  relative_path: string;
  delimiter: "," | "\t";
  header: readonly string[];
  bytes: Buffer;
  row_count: number;
  source_locators: readonly SourceLocatorV2[];
}

interface Fixture {
  root: string;
  commitParentReal: string;
  committedRoot: string;
  committedRootRef: string;
  evidence: TransformQuarantineAdmissionEvidence;
  expected: ExpectedOperationAdmission;
}

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const EXPRESSION_SEED: OutputSeed = {
  table_id: "expression",
  schema_ref: "schema_expression_v1",
  artifact_ref: "artifact_expression_fixture",
  locator_ref: "locator_expression_fixture",
  relative_path: "expression.csv",
  delimiter: ",",
  header: ["sample_id", "value"],
  bytes: TABLE_BYTES,
  row_count: 1,
  source_locators: [INPUT_LOCATOR],
};

async function createFixture(seeds: readonly OutputSeed[] = [EXPRESSION_SEED]): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "operation-result-admission-"));
  cleanupRoots.push(root);
  const commitParent = path.join(root, "core-commits");
  await mkdir(commitParent);
  const committedRootRef = "transform-quarantine-fixture-root";
  const committedRoot = path.join(commitParent, committedRootRef);
  await mkdir(committedRoot);
  for (const seed of seeds) {
    const parent = path.dirname(path.join(committedRoot, ...seed.relative_path.split("/")));
    if (parent !== committedRoot) await mkdir(parent, { recursive: true });
    await writeFile(path.join(committedRoot, ...seed.relative_path.split("/")), seed.bytes);
  }
  const outputs = seeds.map((seed) => ({
    table_id: seed.table_id,
    schema_ref: seed.schema_ref,
    artifact_ref: seed.artifact_ref,
    locator_ref: seed.locator_ref,
    relative_path: seed.relative_path,
    delimiter: seed.delimiter,
    header: [...seed.header],
    size_bytes: seed.bytes.byteLength,
    sha256: sha256(seed.bytes),
    row_count: seed.row_count,
    source_locators: [...seed.source_locators],
  }));
  const evidence: TransformQuarantineAdmissionEvidence = {
    schema_version: "1.0",
    evidence_kind: "transform_quarantine_admission",
    evidence_id: "transform_quarantine_admission_fixture",
    owner: "dataset_core",
    decision: "admitted",
    receipt_evidence_class: "synthetic_test_fixture_receipt",
    fixture_id: "fixture_success_receipt",
    host_receipt_digest: null,
    task_id: "task_operation_admission",
    run_id: "run_operation_admission",
    build_id: "build_operation_admission",
    invocation_id: "invocation_operation_admission",
    attempt: 1,
    generation: 2,
    rejection_code: null,
    rejection_detail: null,
    committed_root_ref: committedRootRef,
    output_digest: canonicalDigest(outputs),
    outputs,
    issued_at: NOW.toISOString(),
  };
  return {
    root,
    commitParentReal: await realpath(commitParent),
    committedRoot,
    committedRootRef,
    evidence,
    expected: makeExpected(),
  };
}

function makeExpected(overrides: Partial<ExpectedOperationAdmission> = {}): ExpectedOperationAdmission {
  return {
    task_id: "task_operation_admission",
    build_id: "build_operation_admission",
    attempt: 1,
    generation: 2,
    expected_exit_state: "succeeded",
    operation_id: "transform_expression",
    operation_attempt_id: "op_attempt_expression_1",
    operation_kind: "integrate",
    output_kind: "integrated_table",
    output_summary: { table_id: "expression" },
    input_digest: HEX_1,
    parameter_digest: HEX_2,
    implementation_digest: HEX_3,
    input_asset_ids: [INPUT_ASSET_ID],
    upstream_result_manifest_ids: [],
    declared_schemas: ["schema_expression_v1"],
    declared_locators: ["locator_expression_fixture"],
    committed_at: COMMITTED_AT,
    ...overrides,
  };
}

function makeInput(
  fixture: Fixture,
  expectedOverrides: Partial<ExpectedOperationAdmission> = {},
  evidenceOverrides: Partial<TransformQuarantineAdmissionEvidence> = {},
): OperationResultAdmissionInput {
  return {
    evidence: { ...fixture.evidence, ...evidenceOverrides },
    expected: makeExpected(expectedOverrides),
    resolve_committed_root: (ref) => path.join(fixture.commitParentReal, ref),
    now: () => NOW,
  };
}

async function expectRejection(
  input: OperationResultAdmissionInput,
  code: string,
): Promise<void> {
  try {
    await admitOperationResultFromQuarantine(input);
  } catch (error) {
    expect(error).toBeInstanceOf(OperationResultAdmissionError);
    expect((error as OperationResultAdmissionError).code).toBe(code);
    return;
  }
  throw new Error(`expected admission rejection ${code}`);
}

/** Full chain: real transform admission evidence feeds the result adapter. */
async function createStageOneFixture(): Promise<{
  commitParent: string;
  request: TransformAdmissionRequest;
  evidence: TransformQuarantineAdmissionEvidence;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "operation-result-admission-e2e-"));
  cleanupRoots.push(root);
  const quarantineRoot = path.join(root, "host-quarantine");
  const commitParent = path.join(root, "core-commits");
  await mkdir(quarantineRoot);
  await mkdir(commitParent);
  await writeFile(path.join(quarantineRoot, "expression.csv"), TABLE_BYTES);

  const familySeed: FamilySpec = {
    family_spec_id: "fs_expression_fixture",
    semantic_version: "1_0_0",
    canonical_digest: HEX_A,
    projections: [],
    table_definitions: [],
    relations: [],
    identity: {
      dataset_id_scheme: "ds_hash",
      dataset_revision_id_scheme: "dsrev_hash",
      asset_id_scheme: "asset_sha256",
      sample_identity_fields: ["dataset_revision_id", "sample_id"],
      probe_mapping_assertion_pk: "mapping_assertion_id",
    },
    transform_capability_refs: [],
    declared_outputs: [{ table_id: "expression", schema_ref: "schema_expression_v1" }],
    integration_policy_ref: "policy_integration",
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
    resource_class_request: "standard",
    scope: "task",
    author: "operation_result_admission_test",
    evidence_refs: [],
  };
  const familySpec: FamilySpec = {
    ...familySeed,
    canonical_digest: await computeFamilySpecDigest(familySeed),
  };
  const implementation: ImplementationDigestInput = {
    normalized_source_sha256: HEX_A,
    emitted_bundle_sha256: HEX_B,
    compiler_id: "tsc",
    compiler_version: "5_9_2",
    compiler_options_digest: HEX_C,
    dependency_closure_digest: HEX_D,
    runtime_abi_version: "node_22",
    host_policy_version: "host_policy_1",
  };
  const implementationDigest = await computeImplementationDigest(implementation);
  const transformDescriptor: TransformDescriptorDigestInput = {
    transform_id: "transform_expression_fixture",
    version: "1_0_0",
    entrypoint: "run",
    implementation_digest: implementationDigest,
    bound_family_spec_digest: familySpec.canonical_digest,
    bound_projection_digest: HEX_B,
    declared_input_roles: [{ role: "source", media_type: "text/csv", constraint_ref: null }],
    declared_output_tables: [{ table_id: "expression", schema_ref: "schema_expression_v1" }],
    runtime_policy_digest: HEX_C,
    import_policy_digest: HEX_D,
    resource_policy_digest: HEX_E,
  };
  const transformDescriptorDigest = sha256(buildTransformDescriptorDigestCanonical(transformDescriptor));
  const inputAsset = {
    asset_id: INPUT_ASSET_ID,
    role: "source",
    sha256: HEX_F,
    size_bytes: 42,
    locator_ref: "locator_input_source",
  };
  const resourceLimits = {
    wall_ms: 5_000,
    cpu_ms: 4_000,
    rss_bytes: 1_000_000,
    temp_bytes: 1_000_000,
    output_bytes: 1_000_000,
    log_bytes: 10_000,
    open_files: 32,
    pids: 1,
  };
  const receipt: TransformExecutionReceipt = {
    schema_version: "1.0",
    task_id: "task_operation_admission",
    run_id: "run_operation_admission",
    build_id: "build_operation_admission",
    invocation_id: "invocation_operation_admission",
    attempt: 1,
    generation: 2,
    request_digest: HEX_E,
    parameters_digest: HEX_F,
    family_spec_digest: familySpec.canonical_digest,
    projection_digest: HEX_B,
    transform_digest: transformDescriptorDigest,
    bundle_digest: implementation.emitted_bundle_sha256,
    compiler_digest: HEX_C,
    runtime_digest: HEX_D,
    policy_digest: HEX_9,
    input_asset_receipts: [inputAsset],
    input_result_receipts: [],
    granted_capabilities: ["bounded_reader"],
    resource_limits: resourceLimits,
    sandbox_backend: "container",
    sandbox_config_digest: HEX_8,
    exit_state: "succeeded",
    exit_code: 0,
    exit_signal: null,
    wall_ms: 100,
    cpu_ms: 50,
    rss_bytes: 1_000,
    temp_bytes: 100,
    output_bytes: TABLE_BYTES.byteLength,
    log_bytes: 0,
    quarantined_output_receipts: [
      {
        table_id: "expression",
        schema_ref: "schema_expression_v1",
        artifact_ref: "artifact_expression_fixture",
        locator_ref: "locator_expression_fixture",
        sha256: sha256(TABLE_BYTES),
        size_bytes: TABLE_BYTES.byteLength,
        row_count: 1,
      },
    ],
    stdout_ref: "stdout_fixture",
    stderr_ref: "stderr_fixture",
    audit_refs: [],
    cancellation_state: "none",
    cancel_requested_at: null,
    deadline_at: "2026-08-21T00:01:00.000Z",
    started_at: "2026-08-21T00:00:00.000Z",
    finished_at: "2026-08-21T00:00:01.000Z",
    host_implementation_digest: implementationDigest,
    host_issued_at: "2026-08-21T00:00:02.000Z",
  };
  const cancelFence = { cancellation_state: "none" as const, cancel_requested_at: null };
  const expected: ExpectedTransformInvocation = {
    owner: "dataset_core",
    task_id: receipt.task_id,
    run_id: receipt.run_id,
    build_id: receipt.build_id,
    invocation_id: receipt.invocation_id,
    attempt: receipt.attempt,
    generation: receipt.generation,
    request_digest: receipt.request_digest,
    parameters_digest: receipt.parameters_digest,
    family_spec: familySpec,
    projection_digest: receipt.projection_digest,
    transform_descriptor: transformDescriptor,
    transform_descriptor_digest: transformDescriptorDigest,
    implementation,
    implementation_digest: implementationDigest,
    compiler_digest: receipt.compiler_digest,
    runtime_digest: receipt.runtime_digest,
    input_asset_receipts: [inputAsset],
    input_result_receipts: [],
    backend_policy: {
      sandbox_backend: "container",
      sandbox_config_digest: HEX_8,
      policy_digest: HEX_9,
      granted_capabilities: ["bounded_reader"],
      resource_limits: resourceLimits,
    },
    expected_outputs: [
      {
        table_id: "expression",
        schema_ref: "schema_expression_v1",
        artifact_ref: "artifact_expression_fixture",
        locator_ref: "locator_expression_fixture",
        relative_path: "expression.csv",
        delimiter: ",",
        header: ["sample_id", "value"],
        source_locators: [INPUT_LOCATOR],
      },
    ],
    deadline_fence: { deadline_at: receipt.deadline_at },
    cancel_fence: cancelFence,
  };
  const request: TransformAdmissionRequest = {
    receipt_evidence: {
      evidence_class: "synthetic_test_fixture_receipt",
      fixture_id: "fixture_success_receipt",
      fixture_receipt: receipt,
    },
    expected_invocation: expected,
    quarantine_root: quarantineRoot,
    core_commit_parent: commitParent,
    read_current_cancel_fence: () => cancelFence,
    now: () => NOW,
  };
  const evidence = await admitTransformExecution(request);
  return { commitParent, request, evidence };
}

describe("Core operation result admission", () => {
  it("admits a real transform quarantine evidence and roundtrips a native manifest", async () => {
    const stage = await createStageOneFixture();
    expect(stage.evidence.decision).toBe("admitted");
    if (stage.evidence.committed_root_ref === null) {
      throw new Error("expected committed root ref");
    }
    expect(path.isAbsolute(stage.evidence.committed_root_ref)).toBe(false);

    const input: OperationResultAdmissionInput = {
      evidence: stage.evidence,
      expected: makeExpected(),
      resolve_committed_root: (ref) => path.join(stage.commitParent, ref),
      now: () => NOW,
    };
    const manifest = await admitOperationResultFromQuarantine(input);

    expect(manifest.status).toBe("succeeded");
    expect(manifest.migration).toEqual({ mode: "native", legacy_checkpoint_path: null, migrated_at: null });
    expect(manifest.commit.state).toBe("committed");
    expect(manifest.commit.committed_at).toBe(COMMITTED_AT);
    expect(manifest.task_id).toBe(stage.evidence.task_id);
    expect(manifest.build_id).toBe(stage.evidence.build_id);
    expect(manifest.attempt).toBe(stage.evidence.attempt);
    expect(manifest.output_digest).toBe(stage.evidence.output_digest);
    expect(manifest.output_files).toEqual([
      {
        relative_path: "expression.csv",
        size_bytes: TABLE_BYTES.byteLength,
        sha256: sha256(TABLE_BYTES),
      },
    ]);
    expect(manifest.result_manifest_id).toBe(
      canonicalDigest({
        task_id: manifest.task_id,
        build_id: manifest.build_id,
        operation_id: manifest.operation_id,
        operation_attempt_id: manifest.operation_attempt_id,
      }),
    );
    expect(manifest.commit.commit_id).toBe(
      canonicalDigest({ result_manifest_id: manifest.result_manifest_id, committed_at: COMMITTED_AT }),
    );

    expect(parseOperationResultManifest(manifest, manifest.task_id, manifest.build_id)).toEqual(manifest);
    expect(parseOperationResultManifest(
      JSON.parse(JSON.stringify(manifest)) as unknown,
      manifest.task_id,
      manifest.build_id,
    )).toEqual(manifest);
    expect("candidate_id" in manifest).toBe(false);
    expect("publication_id" in manifest).toBe(false);
  });

  it("produces deterministic manifest digests for identical inputs", async () => {
    const fixture = await createFixture();
    const first = await admitOperationResultFromQuarantine(makeInput(fixture));
    const second = await admitOperationResultFromQuarantine(makeInput(fixture));
    expect(second).toEqual(first);
    expect(second.result_manifest_id).toBe(first.result_manifest_id);
    expect(second.output_digest).toBe(first.output_digest);
    expect(second.commit.commit_id).toBe(first.commit.commit_id);

    const later = await admitOperationResultFromQuarantine(makeInput(fixture, {
      committed_at: "2026-08-21T00:00:06.000Z",
    }));
    expect(later.result_manifest_id).toBe(first.result_manifest_id);
    expect(later.output_digest).toBe(first.output_digest);
    expect(later.commit.committed_at).not.toBe(first.commit.committed_at);
    expect(later.commit.commit_id).not.toBe(first.commit.commit_id);
  });

  it("rejects committed bytes tampered after the evidence was issued", async () => {
    const fixture = await createFixture();
    await writeFile(
      path.join(fixture.committedRoot, "expression.csv"),
      Buffer.from("sample_id,value\nS1,2\n", "utf8"),
    );
    await expectRejection(makeInput(fixture), "OUTPUT_BYTES_MISMATCH");
  });

  it("rejects symlinks and junctions inside the committed root", async () => {
    const fixture = await createFixture();
    const outside = path.join(fixture.root, "outside.txt");
    await writeFile(outside, "outside bytes\n");

    const symlinkTarget = path.join(fixture.committedRoot, "expression.csv");
    await rm(symlinkTarget);
    try {
      await symlink(outside, symlinkTarget);
    } catch {
      // File symlinks need privileges on win32; junctions cover that platform.
      await symlink(fixture.root, path.join(fixture.committedRoot, "escape-junction"), "junction");
    }
    await expectRejection(makeInput(fixture), "INVALID_COMMITTED_ROOT");
  });

  it("rejects hard-linked committed files", async () => {
    const fixture = await createFixture();
    try {
      await link(
        path.join(fixture.committedRoot, "expression.csv"),
        path.join(fixture.committedRoot, "expression-linked.csv"),
      );
    } catch {
      return; // filesystem does not support hard links; covered on POSIX CI
    }
    await expectRejection(makeInput(fixture), "INVALID_COMMITTED_ROOT");
  });

  it("rejects undeclared extra files in the committed root", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.committedRoot, "undeclared.csv"), "x\n1\n");
    await expectRejection(makeInput(fixture), "CLOSED_WORLD_MISMATCH");
  });

  it("rejects missing declared files in the committed root", async () => {
    const fixture = await createFixture();
    await rm(path.join(fixture.committedRoot, "expression.csv"));
    await expectRejection(makeInput(fixture), "CLOSED_WORLD_MISMATCH");
  });

  it("rejects non-succeeded, cancelled, sandbox-unavailable, and rejected evidence", async () => {
    const fixture = await createFixture();
    for (const exitState of ["failed", "cancelled", "sandbox_unavailable", "timeout"]) {
      await expectRejection(
        makeInput(fixture, { expected_exit_state: exitState as ExpectedOperationAdmission["expected_exit_state"] }),
        "NON_SUCCESS_TERMINAL_STATE",
      );
    }
    await expectRejection(
      makeInput(fixture, {}, {
        decision: "rejected",
        rejection_code: "NON_SUCCESS_TERMINAL_STATE",
        rejection_detail: "production admission rejects exit_state=sandbox_unavailable",
        committed_root_ref: null,
        output_digest: null,
        outputs: [],
      }),
      "REJECTED_EVIDENCE",
    );
  });

  it("rejects cross-task, cross-build, and cross-attempt binding mismatches", async () => {
    const fixture = await createFixture();
    await expectRejection(makeInput(fixture, { task_id: "task_other" }), "CROSS_TASK_MISMATCH");
    await expectRejection(makeInput(fixture, { build_id: "build_other" }), "CROSS_TASK_MISMATCH");
    await expectRejection(makeInput(fixture, { attempt: 2 }), "CROSS_TASK_MISMATCH");
  });

  it("rejects stale and future quarantine generations", async () => {
    const fixture = await createFixture();
    await expectRejection(
      makeInput(fixture, {}, { generation: 1 }),
      "LATE_GENERATION",
    );
    await expectRejection(
      makeInput(fixture, {}, { generation: 3 }),
      "LATE_GENERATION",
    );
  });

  it("rejects an evidence output digest that does not close over its outputs", async () => {
    const fixture = await createFixture();
    await expectRejection(
      makeInput(fixture, {}, { output_digest: HEX_4 }),
      "EVIDENCE_DIGEST_MISMATCH",
    );
  });

  it("enforces the full operation kind / output kind pairing", async () => {
    const fixture = await createFixture();
    for (const [operationKind, outputKind] of OPERATION_OUTPUT_PAIRS) {
      const manifest = await admitOperationResultFromQuarantine(makeInput(fixture, {
        operation_kind: operationKind as ExpectedOperationAdmission["operation_kind"],
        output_kind: outputKind as ExpectedOperationAdmission["output_kind"],
      }));
      expect(manifest.operation_kind).toBe(operationKind);
      expect(manifest.output_kind).toBe(outputKind);
    }
    await expectRejection(
      makeInput(fixture, { operation_kind: "assemble", output_kind: "parsed_table" }),
      "OUTPUT_KIND_MISMATCH",
    );
    await expectRejection(
      makeInput(fixture, { operation_kind: "derive", output_kind: "publication_manifest" }),
      "OUTPUT_KIND_MISMATCH",
    );
  });

  it("rejects absolute paths at every admission boundary", async () => {
    const fixture = await createFixture();
    await expectRejection(
      { ...makeInput(fixture), resolve_committed_root: () => fixture.committedRootRef },
      "ABSOLUTE_PATH",
    );
    await expectRejection(
      makeInput(fixture, {}, { committed_root_ref: "/absolute/ref" }),
      "ABSOLUTE_PATH",
    );
    await expectRejection(
      makeInput(fixture, {}, {
        committed_root_ref: fixture.committedRootRef,
        outputs: [{
          ...fixture.evidence.outputs[0]!,
          relative_path: "/absolute.csv",
        }],
        output_digest: canonicalDigest([{ ...fixture.evidence.outputs[0]!, relative_path: "/absolute.csv" }]),
      }),
      "ABSOLUTE_PATH",
    );
  });

  it("rejects unknown schema, locator, and input references", async () => {
    const fixture = await createFixture();
    await expectRejection(
      makeInput(fixture, { declared_schemas: [] }),
      "UNKNOWN_SCHEMA",
    );
    await expectRejection(
      makeInput(fixture, { declared_locators: [] }),
      "UNKNOWN_LOCATOR",
    );
    await expectRejection(
      makeInput(fixture, { input_asset_ids: [] }),
      "UNKNOWN_INPUT",
    );
    await expectRejection(
      makeInput(fixture, { declared_schemas: ["schema_expression_v1", "schema_unused_v1"] }),
      "INVALID_EXPECTED_OPERATION",
    );
  });

  it("rejects malformed or non-admitted evidence", async () => {
    const fixture = await createFixture();
    await expectRejection(
      makeInput(fixture, {}, { decision: "rejected" }),
      "REJECTED_EVIDENCE",
    );
    await expectRejection(
      makeInput(fixture, {}, { committed_root_ref: null }),
      "INVALID_EVIDENCE",
    );
    await expectRejection(
      makeInput(fixture, {}, { outputs: [] }),
      "INVALID_EVIDENCE",
    );
    await expectRejection(
      makeInput(fixture, {}, { output_digest: "not-a-digest" }),
      "INVALID_EVIDENCE",
    );
  });

  it("sorts output file receipts deterministically by relative path", async () => {
    const zebra: OutputSeed = {
      ...EXPRESSION_SEED,
      table_id: "zebra",
      schema_ref: "schema_zebra_v1",
      artifact_ref: "artifact_zebra_fixture",
      locator_ref: "locator_zebra_fixture",
      relative_path: "tables/zebra.csv",
      bytes: TABLE2_BYTES,
    };
    const alpha: OutputSeed = {
      ...EXPRESSION_SEED,
      table_id: "alpha",
      schema_ref: "schema_alpha_v1",
      artifact_ref: "artifact_alpha_fixture",
      locator_ref: "locator_alpha_fixture",
      relative_path: "tables/alpha.csv",
      bytes: TABLE2_BYTES,
    };
    const fixture = await createFixture([zebra, alpha]);
    const manifest = await admitOperationResultFromQuarantine(makeInput(fixture, {
      output_summary: { tables: ["alpha", "zebra"] },
      declared_schemas: ["schema_zebra_v1", "schema_alpha_v1"],
      declared_locators: ["locator_zebra_fixture", "locator_alpha_fixture"],
    }));

    expect(manifest.output_files.map((file) => file.relative_path)).toEqual([
      "tables/alpha.csv",
      "tables/zebra.csv",
    ]);
    expect(await readFile(path.join(fixture.committedRoot, "tables", "zebra.csv"))).toEqual(TABLE2_BYTES);
    expect(manifest.output_files[0]!.sha256).toBe(sha256(TABLE2_BYTES));
  });
});
