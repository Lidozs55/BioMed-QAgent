import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildTransformDescriptorDigestCanonical,
  computeFamilySpecDigest,
  computeImplementationDigest,
  type FamilySpec,
  type ImplementationDigestInput,
  type ResourceLimits,
  type SourceLocatorV2,
  type TransformDescriptorDigestInput,
  type TransformExecutionReceipt,
} from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { InProcessUnisolatedResult } from "../transform-host/in-process-unisolated.js";
import type { ExpectedTransformInvocation } from "../transform-admission/types.js";
import { OperationResultAdmissionError } from "./admission.js";
import { admitInProcessUnisolatedResult } from "./in-process-unisolated-composition.js";
import type { ExpectedOperationAdmission } from "./types.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);
const HEX_E = "e".repeat(64);
const HEX_F = "f".repeat(64);
const TABLE_BYTES = new TextEncoder().encode("sample_id,value\nS1,1\n");
const NOW = new Date("2026-08-22T00:00:03.000Z");
const cleanupRoots: string[] = [];

interface Fixture {
  root: string;
  commitParent: string;
  result: InProcessUnisolatedResult;
  expectedInvocation: ExpectedTransformInvocation;
  expectedOperation: ExpectedOperationAdmission;
}

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "unisolated-composition-test-"));
  cleanupRoots.push(root);
  const commitParent = path.join(root, "core-commits");
  await mkdir(commitParent, { mode: 0o700 });

  const assetId = `asset_${HEX_F}`;
  const sourceLocator: SourceLocatorV2 = {
    locator_version: "2.0",
    locator_type: "json_pointer",
    asset_id: assetId,
    logical_file: "source.json",
    raw_value: "S1",
    json_pointer: "/samples/0",
  };
  const familySeed: FamilySpec = {
    family_spec_id: "fs_unisolated_composition",
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
    author: "unisolated_composition_test",
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
    transform_id: "transform_unisolated_composition",
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
  const transformDescriptorDigest = sha256(
    buildTransformDescriptorDigestCanonical(transformDescriptor),
  );
  const resourceLimits: ResourceLimits = {
    wall_ms: 5_000,
    cpu_ms: 4_000,
    rss_bytes: 1_000_000,
    temp_bytes: 1_000_000,
    output_bytes: 1_000_000,
    log_bytes: 10_000,
    open_files: 32,
    pids: 1,
  };
  const inputAsset = {
    asset_id: assetId,
    role: "source",
    sha256: HEX_F,
    size_bytes: 42,
    locator_ref: "locator_input_source",
  };
  const handle = "out_table";
  const receipt: TransformExecutionReceipt = {
    schema_version: "1.0",
    task_id: "task_unisolated_composition",
    run_id: "run_unisolated_composition",
    build_id: "build_unisolated_composition",
    invocation_id: "invocation_unisolated_composition",
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
    policy_digest: HEX_A,
    input_asset_receipts: [inputAsset],
    input_result_receipts: [],
    granted_capabilities: ["bounded_log", "bounded_output"],
    resource_limits: resourceLimits,
    sandbox_backend: "in_process_unisolated",
    sandbox_config_digest: HEX_B,
    exit_state: "succeeded",
    exit_code: 0,
    exit_signal: null,
    wall_ms: 1,
    cpu_ms: 0,
    rss_bytes: 0,
    temp_bytes: 0,
    output_bytes: TABLE_BYTES.byteLength,
    log_bytes: 0,
    quarantined_output_receipts: [{
      table_id: "expression",
      schema_ref: "schema_expression_v1",
      artifact_ref: `transform-host://invocation_unisolated_composition/output/${handle}`,
      locator_ref: "locator_expression_fixture",
      sha256: sha256(TABLE_BYTES),
      size_bytes: TABLE_BYTES.byteLength,
      row_count: 1,
    }],
    stdout_ref: "transform-host://invocation_unisolated_composition/stdout/in-memory",
    stderr_ref: "transform-host://invocation_unisolated_composition/stderr/in-memory",
    audit_refs: [
      "transform-host://invocation_unisolated_composition/in-process-unisolated-not-security-boundary",
    ],
    cancellation_state: "none",
    cancel_requested_at: null,
    deadline_at: "2026-08-22T00:01:00.000Z",
    started_at: "2026-08-22T00:00:00.000Z",
    finished_at: "2026-08-22T00:00:01.000Z",
    host_implementation_digest: HEX_C,
    host_issued_at: "2026-08-22T00:00:01.000Z",
  };
  const expectedInvocation: ExpectedTransformInvocation = {
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
      sandbox_backend: "in_process_unisolated",
      sandbox_config_digest: receipt.sandbox_config_digest,
      policy_digest: receipt.policy_digest,
      granted_capabilities: [...receipt.granted_capabilities],
      resource_limits: resourceLimits,
    },
    expected_outputs: [{
      table_id: "expression",
      schema_ref: "schema_expression_v1",
      artifact_ref: receipt.quarantined_output_receipts[0]!.artifact_ref,
      locator_ref: "locator_expression_fixture",
      relative_path: "tables/expression.csv",
      delimiter: ",",
      header: ["sample_id", "value"],
      source_locators: [sourceLocator],
    }],
    deadline_fence: { deadline_at: receipt.deadline_at },
    cancel_fence: { cancellation_state: "none", cancel_requested_at: null },
  };
  const expectedOperation: ExpectedOperationAdmission = {
    task_id: receipt.task_id,
    build_id: receipt.build_id,
    attempt: receipt.attempt,
    generation: receipt.generation,
    expected_exit_state: "succeeded",
    operation_id: "transform_unisolated_composition",
    operation_attempt_id: "op_attempt_unisolated_composition_1",
    operation_kind: "integrate",
    output_kind: "integrated_table",
    output_summary: { table_id: "expression" },
    input_digest: HEX_A,
    parameter_digest: receipt.parameters_digest,
    implementation_digest: implementationDigest,
    input_asset_ids: [assetId],
    upstream_result_manifest_ids: [],
    declared_schemas: ["schema_expression_v1"],
    declared_locators: ["locator_expression_fixture"],
    committed_at: "2026-08-22T00:00:05.000Z",
  };
  const result: InProcessUnisolatedResult = Object.freeze({
    receipt,
    outputs: Object.freeze([{ handle, bytes: Uint8Array.from(TABLE_BYTES) }]),
    stdout: "",
    stderr: "",
  });
  return { root, commitParent, result, expectedInvocation, expectedOperation };
}

function compose(fixture: Fixture, result = fixture.result) {
  return admitInProcessUnisolatedResult({
    result,
    expected_invocation: fixture.expectedInvocation,
    expected_operation: fixture.expectedOperation,
    core_commit_parent: fixture.commitParent,
    read_current_cancel_fence: () => fixture.expectedInvocation.cancel_fence,
    resolve_committed_root: (ref) => path.join(fixture.commitParent, ref),
    now: () => NOW,
  });
}

describe("Core in-process unisolated result composition", () => {
  it("writes private quarantine bytes and returns a native OperationResultManifest", async () => {
    const fixture = await createFixture();

    const manifest = await compose(fixture);

    expect(manifest).toMatchObject({
      task_id: fixture.expectedInvocation.task_id,
      build_id: fixture.expectedInvocation.build_id,
      status: "succeeded",
      output_kind: "integrated_table",
      migration: { mode: "native", legacy_checkpoint_path: null, migrated_at: null },
    });
    expect(manifest.output_files).toEqual([{
      relative_path: "tables/expression.csv",
      size_bytes: TABLE_BYTES.byteLength,
      sha256: sha256(TABLE_BYTES),
    }]);
    const committedRoots = await readdir(fixture.commitParent);
    expect(committedRoots).toHaveLength(1);
    expect(committedRoots[0]).toMatch(/^transform-quarantine-/u);
    await expect(readFile(path.join(
      fixture.commitParent,
      committedRoots[0]!,
      "tables",
      "expression.csv",
    ))).resolves.toEqual(Buffer.from(TABLE_BYTES));
  });

  it("rejects in-memory output bytes that tamper with the receipted digest", async () => {
    const fixture = await createFixture();
    const result: InProcessUnisolatedResult = {
      ...fixture.result,
      outputs: [{ handle: "out_table", bytes: new TextEncoder().encode("sample_id,value\nS1,2\n") }],
    };

    await expect(compose(fixture, result)).rejects.toMatchObject<OperationResultAdmissionError>({
      code: "REJECTED_EVIDENCE",
    });
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects non-succeeded completed receipts", async () => {
    const fixture = await createFixture();
    const result: InProcessUnisolatedResult = {
      ...fixture.result,
      receipt: {
        ...fixture.result.receipt,
        exit_state: "failed",
        exit_code: 1,
        output_bytes: 0,
        quarantined_output_receipts: [],
      },
      outputs: [],
    };

    await expect(compose(fixture, result)).rejects.toThrow(
      "Cannot compose non-succeeded in-process result: failed",
    );
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });

  it("rejects an output and receipt count mismatch before staging", async () => {
    const fixture = await createFixture();
    const result: InProcessUnisolatedResult = { ...fixture.result, outputs: [] };

    await expect(compose(fixture, result)).rejects.toThrow(
      "In-process output, receipt, and Core descriptor counts must match exactly",
    );
    await expect(readdir(fixture.commitParent)).resolves.toEqual([]);
  });
});
