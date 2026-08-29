import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildTransformDescriptorDigestCanonical,
  computeFamilySpecDigest,
  computeImplementationDigest,
  type FamilySpec,
  type ImplementationDigestInput,
  type TransformDescriptorDigestInput,
  type TransformExecutionReceipt,
} from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { admitTransformExecution } from "./admission.js";
import type {
  ExpectedTransformCancelFence,
  ExpectedTransformInvocation,
  TransformAdmissionRequest,
} from "./types.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);
const HEX_F = "f".repeat(64);
const HEX_8 = "8".repeat(64);
const HEX_9 = "9".repeat(64);
const NOW = new Date("2026-08-21T00:00:03.000Z");
const TABLE_BYTES = Buffer.from("sample_id,value\nS1,1\n", "utf8");

interface Fixture {
  root: string;
  quarantineRoot: string;
  commitParent: string;
  receipt: TransformExecutionReceipt;
  expected: ExpectedTransformInvocation;
  request: TransformAdmissionRequest;
}

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "transform-admission-"));
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
    author: "transform_admission_test",
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
    declared_input_roles: [
      { role: "source", media_type: "text/csv", constraint_ref: null },
    ],
    declared_output_tables: [{ table_id: "expression", schema_ref: "schema_expression_v1" }],
    runtime_policy_digest: HEX_C,
    import_policy_digest: HEX_D,
    resource_policy_digest: HEX_E,
  };
  const transformDescriptorDigest = sha256(
    buildTransformDescriptorDigestCanonical(transformDescriptor),
  );
  const inputAsset = {
    asset_id: `asset_${HEX_F}`,
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
    task_id: "task_fixture",
    run_id: "run_fixture",
    requirement_id: "build_fixture",
    invocation_id: "invocation_fixture",
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
    execution_backend: "container",
    execution_config_digest: HEX_8,
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
  const cancelFence: ExpectedTransformCancelFence = {
    cancellation_state: "none",
    cancel_requested_at: null,
  };
  const expected: ExpectedTransformInvocation = {
    owner: "dataset_core",
    task_id: receipt.task_id,
    run_id: receipt.run_id,
    requirement_id: receipt.requirement_id,
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
      execution_backend: "container",
      execution_config_digest: HEX_8,
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
        source_locators: [
          {
            locator_version: "2.0",
            locator_type: "json_pointer",
            asset_id: inputAsset.asset_id,
            logical_file: "source.json",
            raw_value: "S1",
            json_pointer: "/samples/0",
          },
        ],
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
  return { root, quarantineRoot, commitParent, receipt, expected, request };
}

function productionRequest(fixture: Fixture, receipt: TransformExecutionReceipt): TransformAdmissionRequest {
  return {
    ...fixture.request,
    receipt_evidence: {
      evidence_class: "production_host_receipt",
      wire_receipt: receipt,
    },
  };
}

describe("Core transform quarantine admission", () => {
  it("admits only an explicitly classified synthetic success fixture and commits independent bytes", async () => {
    const fixture = await createFixture();

    const evidence = await admitTransformExecution(fixture.request);

    expect(evidence.decision).toBe("admitted");
    expect(evidence.receipt_evidence_class).toBe("synthetic_test_fixture_receipt");
    expect(evidence.fixture_id).toBe("fixture_success_receipt");
    expect(evidence.outputs).toHaveLength(1);
    expect(evidence.outputs[0]).toMatchObject({
      sha256: sha256(TABLE_BYTES),
      size_bytes: TABLE_BYTES.byteLength,
      row_count: 1,
      header: ["sample_id", "value"],
    });
    expect(evidence.committed_root_ref).toMatch(/^transform-quarantine-/);
    if (evidence.committed_root_ref === null) throw new Error("expected committed root ref");
    expect(path.isAbsolute(evidence.committed_root_ref)).toBe(false);
    const committedPath = path.join(
      await realpath(fixture.commitParent),
      evidence.committed_root_ref,
    );
    expect(committedPath.toLowerCase().startsWith(fixture.quarantineRoot.toLowerCase())).toBe(false);
    await expect(readFile(path.join(committedPath, "expression.csv"))).resolves.toEqual(TABLE_BYTES);
  });

  it("admits multiple output tables that share one registered source locator", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.quarantineRoot, "supporting.csv"), TABLE_BYTES);
    const secondDeclared = { table_id: "supporting", schema_ref: "schema_supporting_v1" };
    const familySeed: FamilySpec = {
      ...fixture.expected.family_spec,
      canonical_digest: HEX_A,
      declared_outputs: [...fixture.expected.family_spec.declared_outputs, secondDeclared],
    };
    const familySpec: FamilySpec = {
      ...familySeed,
      canonical_digest: await computeFamilySpecDigest(familySeed),
    };
    const transformDescriptor: TransformDescriptorDigestInput = {
      ...fixture.expected.transform_descriptor,
      bound_family_spec_digest: familySpec.canonical_digest,
      declared_output_tables: [
        ...fixture.expected.transform_descriptor.declared_output_tables,
        secondDeclared,
      ],
    };
    const transformDescriptorDigest = sha256(
      buildTransformDescriptorDigestCanonical(transformDescriptor),
    );
    const secondExpected = {
      ...fixture.expected.expected_outputs[0],
      table_id: "supporting",
      schema_ref: "schema_supporting_v1",
      artifact_ref: "artifact_supporting_fixture",
      // Deliberately shared: both tables derive from the same source receipt.
      locator_ref: fixture.expected.expected_outputs[0]!.locator_ref,
      relative_path: "supporting.csv",
    };
    const secondReceipt = {
      ...fixture.receipt.quarantined_output_receipts[0]!,
      table_id: "supporting",
      schema_ref: "schema_supporting_v1",
      artifact_ref: "artifact_supporting_fixture",
      locator_ref: fixture.receipt.quarantined_output_receipts[0]!.locator_ref,
    };
    const receipt: TransformExecutionReceipt = {
      ...fixture.receipt,
      family_spec_digest: familySpec.canonical_digest,
      transform_digest: transformDescriptorDigest,
      output_bytes: TABLE_BYTES.byteLength * 2,
      quarantined_output_receipts: [
        ...fixture.receipt.quarantined_output_receipts,
        secondReceipt,
      ],
    };
    const expected: ExpectedTransformInvocation = {
      ...fixture.expected,
      family_spec: familySpec,
      transform_descriptor: transformDescriptor,
      transform_descriptor_digest: transformDescriptorDigest,
      expected_outputs: [...fixture.expected.expected_outputs, secondExpected],
    };
    const evidence = await admitTransformExecution({
      ...fixture.request,
      receipt_evidence: {
        evidence_class: "synthetic_test_fixture_receipt",
        fixture_id: "fixture_shared_locator_receipt",
        fixture_receipt: receipt,
      },
      expected_invocation: expected,
    });

    expect(evidence.decision).toBe("admitted");
    expect(evidence.outputs).toHaveLength(2);
    expect(evidence.outputs.map((output) => output.locator_ref)).toEqual([
      fixture.expected.expected_outputs[0]!.locator_ref,
      fixture.expected.expected_outputs[0]!.locator_ref,
    ]);
  });

  it("rejects receipt-shaped input without an explicit evidence class", async () => {
    const fixture = await createFixture();
    const evidence = await admitTransformExecution({
      ...fixture.request,
      receipt_evidence: { wire_receipt: fixture.receipt } as unknown as TransformAdmissionRequest["receipt_evidence"],
    });

    expect(evidence.decision).toBe("rejected");
    expect(evidence.rejection_code).toBe("INVALID_RECEIPT");
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects the production Host sandbox_unavailable receipt", async () => {
    const fixture = await createFixture();
    const unavailable: TransformExecutionReceipt = {
      ...fixture.receipt,
      execution_backend: "unavailable",
      exit_state: "sandbox_unavailable",
      exit_code: null,
      output_bytes: 0,
      quarantined_output_receipts: [],
    };

    const evidence = await admitTransformExecution(productionRequest(fixture, unavailable));

    expect(evidence.decision).toBe("rejected");
    expect(evidence.rejection_code).toBe("NON_SUCCESS_TERMINAL_STATE");
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects non-succeeded and late-cancel production receipts", async () => {
    const fixture = await createFixture();
    const failed: TransformExecutionReceipt = {
      ...fixture.receipt,
      exit_state: "failed",
      exit_code: 1,
    };
    const lateCancel: TransformExecutionReceipt = {
      ...fixture.receipt,
      cancellation_state: "requested",
      cancel_requested_at: "2026-08-21T00:00:00.500Z",
    };

    const failedEvidence = await admitTransformExecution(productionRequest(fixture, failed));
    const cancelEvidence = await admitTransformExecution(productionRequest(fixture, lateCancel));

    expect(failedEvidence.rejection_code).toBe("NON_SUCCESS_TERMINAL_STATE");
    expect(cancelEvidence.rejection_code).toBe("LATE_CANCELLATION");
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects placeholder cell values and all-empty data rows", async () => {
    const placeholderTable = Buffer.from("sample_id,value\nUNKNOWN,placeholder\n", "utf8");
    const placeholderFixture = await createFixture();
    await writeFile(path.join(placeholderFixture.quarantineRoot, "expression.csv"), placeholderTable);
    const placeholderReceipt = {
      ...placeholderFixture.receipt,
      output_bytes: placeholderTable.byteLength,
      quarantined_output_receipts: [
        {
          ...placeholderFixture.receipt.quarantined_output_receipts[0]!,
          sha256: sha256(placeholderTable),
          size_bytes: placeholderTable.byteLength,
          row_count: 1,
        },
      ],
    };
    const placeholderEvidence = await admitTransformExecution(
      productionRequest(placeholderFixture, placeholderReceipt),
    );
    expect(placeholderEvidence.rejection_code).toBe("PLACEHOLDER_CONTENT");

    const emptyRowTable = Buffer.from("sample_id,value\nS1,7\n,\n", "utf8");
    const emptyRowFixture = await createFixture();
    await writeFile(path.join(emptyRowFixture.quarantineRoot, "expression.csv"), emptyRowTable);
    const emptyRowReceipt = {
      ...emptyRowFixture.receipt,
      output_bytes: emptyRowTable.byteLength,
      quarantined_output_receipts: [
        {
          ...emptyRowFixture.receipt.quarantined_output_receipts[0]!,
          sha256: sha256(emptyRowTable),
          size_bytes: emptyRowTable.byteLength,
          row_count: 2,
        },
      ],
    };
    const emptyRowEvidence = await admitTransformExecution(
      productionRequest(emptyRowFixture, emptyRowReceipt),
    );
    expect(emptyRowEvidence.rejection_code).toBe("PLACEHOLDER_CONTENT");
    await expect(readdir(placeholderFixture.commitParent)).resolves.toEqual([]);
    await expect(readdir(emptyRowFixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects non-canonical expected digests and expired deadlines before copying", async () => {
    const digestFixture = await createFixture();
    const digestEvidence = await admitTransformExecution({
      ...digestFixture.request,
      expected_invocation: {
        ...digestFixture.expected,
        request_digest: digestFixture.expected.request_digest.toUpperCase(),
      },
    });
    expect(digestEvidence.rejection_code).toBe("INVALID_EXPECTED_INVOCATION");
    await expect(readdir(digestFixture.commitParent)).resolves.toEqual([]);

    const deadlineFixture = await createFixture();
    const deadlineEvidence = await admitTransformExecution({
      ...deadlineFixture.request,
      now: () => new Date("2026-08-21T00:02:00.000Z"),
    });
    expect(deadlineEvidence.rejection_code).toBe("DEADLINE_FENCE_VIOLATION");
    await expect(readdir(deadlineFixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects an invocation identity mismatch before copying", async () => {
    const fixture = await createFixture();
    const evidence = await admitTransformExecution({
      ...fixture.request,
      expected_invocation: {
        ...fixture.expected,
        generation: fixture.expected.generation + 1,
      },
    });

    expect(evidence.decision).toBe("rejected");
    expect(evidence.rejection_code).toBe("INVOCATION_BINDING_MISMATCH");
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects byte mutation and removes the partial commit root", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.quarantineRoot, "expression.csv"), "sample_id,value\nS1,2\n");

    const evidence = await admitTransformExecution(fixture.request);

    expect(evidence.decision).toBe("rejected");
    expect(evidence.rejection_code).toBe("OUTPUT_BYTES_MISMATCH");
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects closed-world extras and NUL-bearing output tuples", async () => {
    const extraFixture = await createFixture();
    await writeFile(path.join(extraFixture.quarantineRoot, "undeclared.csv"), "x\n1\n");
    const extraEvidence = await admitTransformExecution(extraFixture.request);

    const nulFixture = await createFixture();
    const nulEvidence = await admitTransformExecution({
      ...nulFixture.request,
      expected_invocation: {
        ...nulFixture.expected,
        expected_outputs: [
          { ...nulFixture.expected.expected_outputs[0], relative_path: "expression.csv\0smuggled" },
        ],
      },
    });

    expect(extraEvidence.rejection_code).toBe("OUTPUT_CLOSURE_MISMATCH");
    expect(nulEvidence.rejection_code).toBe("INVALID_EXPECTED_INVOCATION");
    await expect(readdir(extraFixture.commitParent)).resolves.toEqual([]);
    await expect(readdir(nulFixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects a late Core cancellation fence and cleans staging bytes", async () => {
    const fixture = await createFixture();
    let reads = 0;
    const evidence = await admitTransformExecution({
      ...fixture.request,
      read_current_cancel_fence: () => {
        reads += 1;
        return reads === 1
          ? fixture.expected.cancel_fence
          : {
              cancellation_state: "requested",
              cancel_requested_at: "2026-08-21T00:00:00.500Z",
            };
      },
    });

    expect(evidence.decision).toBe("rejected");
    expect(evidence.rejection_code).toBe("LATE_CANCELLATION");
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });

  it("uses the shared FamilySpec digest verifier and rejects a forged digest", async () => {
    const fixture = await createFixture();
    const evidence = await admitTransformExecution({
      ...fixture.request,
      expected_invocation: {
        ...fixture.expected,
        family_spec: { ...fixture.expected.family_spec, canonical_digest: HEX_A },
      },
    });

    expect(evidence.decision).toBe("rejected");
    expect(evidence.rejection_code).toBe("INVALID_FAMILY_SPEC_DIGEST");
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });
});
