import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  DatasetSchemaV2,
  OperationResultManifest,
  TableDefinition,
} from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { MultiTableValidationRequest } from "../src/dataset/contracts/validation.js";
import { OperationAbortedError } from "../src/dataset/cooperative.js";
import {
  validateMultiTableCandidate,
  type MultiTableResourcePreflightTelemetry,
  type MultiTableValidationOptions,
} from "../src/dataset/validation/multitable.js";
import type {
  MultiTableResourceEstimates,
  ResourceBaselinePolicy,
} from "../src/dataset/validation/resource-baseline.js";

const DIGEST = "0".repeat(64);
const roots: string[] = [];

const schema: DatasetSchemaV2 = {
  schema_version: "2.0",
  schema_id: "ct4.table.v1",
  dataset_family: "bioactivity_measurement",
  row_granularity: "ct4_test_row",
  primary_key: ["row_id"],
  fields: [{
    schema_version: "2.0",
    name: "row_id",
    data_type: "string",
    semantic_role: "identifier",
    required: true,
    nullable: false,
    unit_policy: null,
    ontology: null,
    description: "test row identifier",
    derivation_policy: null,
  }],
};

const definition: TableDefinition = {
  table_id: "rows",
  schema_ref: schema.schema_id,
  role: "primary",
  required: true,
  allow_empty: false,
  primary_key: ["row_id"],
  field_names: ["row_id"],
};

const policy: ResourceBaselinePolicy = {
  policyId: "ct4-validator-test-policy",
  memoryThresholdBytes: 1_000,
  heapQuotaBytes: 2_000,
  tempQuotaBytes: 10_000,
  rowOverheadBytes: 10,
  keyEntryOverheadBytes: 5,
  tupleFieldOverheadBytes: 2,
};

function estimates(tupleWidthEstimateBytes: number | null): MultiTableResourceEstimates {
  return {
    rowEstimate: 0,
    keyEstimates: [{
      keyId: "rows:primary",
      entryEstimate: 1,
      tupleWidthEstimateBytes,
      tupleFieldCount: 1,
    }],
    configuredHeapBytes: 2_000,
    configuredTempBytes: 10_000,
  };
}

function resourceOptions(
  measuredEstimates: MultiTableResourceEstimates,
  telemetrySink: MultiTableValidationOptions["resourceBaseline"]["telemetrySink"],
): MultiTableValidationOptions {
  return {
    resourceBaseline: {
      policy,
      estimates: measuredEstimates,
      telemetrySink,
    },
  };
}

async function validationRequest(): Promise<MultiTableValidationRequest> {
  const trustedRoot = await mkdtemp(path.join(os.tmpdir(), "ct4-preflight-trusted-"));
  const forbiddenRoot = await mkdtemp(path.join(os.tmpdir(), "ct4-preflight-forbidden-"));
  roots.push(trustedRoot, forbiddenRoot);
  const relativePath = "rows.csv";
  const content = "row_id\nrow-1\n";
  const filePath = path.join(trustedRoot, relativePath);
  await writeFile(filePath, content, "utf8");
  const fileStat = await stat(filePath);
  const fileDigest = createHash("sha256").update(content).digest("hex");
  const operationResult: OperationResultManifest = {
    schema_version: "1.0",
    result_manifest_id: "result_ct4_rows",
    task_id: "task_ct4",
    build_id: "build_ct4",
    operation_id: "integrate_ct4_rows",
    operation_kind: "integrate",
    operation_attempt_id: "attempt_ct4_rows",
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: createHash("sha256").update("ct4-output").digest("hex"),
    output_kind: "integrated_table",
    output_summary: {},
    output_files: [{
      relative_path: relativePath,
      size_bytes: fileStat.size,
      sha256: fileDigest,
    }],
    dependency_closure: {
      input_asset_ids: [],
      upstream_result_manifest_ids: [],
      parameter_digest: DIGEST,
      implementation_digest: DIGEST,
    },
    commit: {
      state: "committed",
      commit_id: "commit_ct4_rows",
      committed_at: "2026-08-22T00:00:00Z",
    },
    migration: {
      mode: "native",
      legacy_checkpoint_path: null,
      migrated_at: null,
    },
  };
  return {
    task_id: "task_ct4",
    build_id: "build_ct4",
    candidate: {
      candidate_id: "candidate_ct4",
      table_ids: [definition.table_id],
      relation_ids: [],
      provenance_refs: ["prov_rows"],
      confidence_refs: ["conf_rows"],
      audit_refs: [],
    },
    tables: [{
      definition,
      schema,
      file: {
        origin: "core_operation_result",
        relative_path: relativePath,
        delimiter: ",",
        operation_result: operationResult,
      },
      provenance_refs: ["prov_rows"],
      confidence_refs: ["conf_rows"],
    }],
    relations: [],
    trusted_root: trustedRoot,
    forbidden_roots: [forbiddenRoot],
    policy: {
      token_preservation_rules: [],
      profile_relation_missing_policies: {},
    },
  };
}

function deterministicTelemetry(
  telemetry: MultiTableResourcePreflightTelemetry,
): Omit<MultiTableResourcePreflightTelemetry, "durationMs" | "heapBytes"> {
  const { durationMs, heapBytes, ...deterministic } = telemetry;
  expect(durationMs).toBeGreaterThanOrEqual(0);
  expect(heapBytes).toBeGreaterThan(0);
  return deterministic;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("C-T4 multi-table resource preflight", () => {
  it("admits the exact memory threshold and emits one auditable telemetry record", async () => {
    const request = await validationRequest();
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];

    const result = await validateMultiTableCandidate(
      request,
      undefined,
      resourceOptions(estimates(993), (event) => {
        telemetry.push(event);
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.checks[0]).toEqual(expect.objectContaining({
      check_id: "resource_baseline",
      passed: true,
    }));
    expect(telemetry).toHaveLength(1);
    expect(deterministicTelemetry(telemetry[0]!)).toEqual({
      schemaVersion: "b3-multitable-resource-preflight.v1",
      validatorMode: "memory",
      thresholdBasis: {
        policyId: policy.policyId,
        memoryThresholdBytes: 1_000,
        policyHeapQuotaBytes: 2_000,
        configuredHeapBytes: 2_000,
        effectiveMemoryThresholdBytes: 1_000,
        policyTempQuotaBytes: 10_000,
        configuredTempBytes: 10_000,
        effectiveTempQuotaBytes: 10_000,
      },
      rowEstimate: 0,
      keyEstimates: [{
        keyId: "rows:primary",
        entryEstimate: 1,
        tupleWidthEstimateBytes: 993,
        tupleFieldCount: 1,
      }],
      configuredHeapBytes: 2_000,
      configuredTempBytes: 10_000,
      estimatedHeapBytes: 1_000,
      estimatedTempBytes: 1_000,
      tempBytes: null,
      failureReason: null,
    });
    expect(telemetry[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(telemetry[0]!.heapBytes).toBeGreaterThan(0);
  });

  it("rejects the first byte above memory before iterating or scanning tables", async () => {
    const request = await validationRequest();
    request.tables = new Proxy(request.tables, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("tables must not be scanned");
        return Reflect.get(target, property, receiver);
      },
    });
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];

    const result = await validateMultiTableCandidate(
      request,
      undefined,
      resourceOptions(estimates(994), (event) => {
        telemetry.push(event);
      }),
    );

    expect(result).toEqual({
      passed: false,
      checks: [expect.objectContaining({
        check_id: "resource_baseline",
        passed: false,
        detail: expect.stringContaining('"failure_reason":"disk_unavailable"'),
      })],
    });
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toEqual(expect.objectContaining({
      validatorMode: "reject",
      estimatedHeapBytes: 1_001,
      failureReason: "disk_unavailable",
      tempBytes: null,
    }));
  });

  it.each([
    ["unknown", estimates(null), "unknown_estimate"],
    ["invalid", { ...estimates(1), rowEstimate: -1 }, "invalid_estimate"],
  ] as const)("fails closed for %s estimates before scanning", async (_label, measured, reason) => {
    const request = await validationRequest();
    request.tables = new Proxy(request.tables, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("tables must not be scanned");
        return Reflect.get(target, property, receiver);
      },
    });
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];

    const result = await validateMultiTableCandidate(
      request,
      undefined,
      resourceOptions(measured, (event) => {
        telemetry.push(event);
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.detail).toContain(`"failure_reason":"${reason}"`);
    expect(telemetry[0]).toEqual(expect.objectContaining({
      validatorMode: "reject",
      estimatedHeapBytes: null,
      estimatedTempBytes: null,
      failureReason: reason,
    }));
  });

  it("honors AbortSignal after telemetry and before table scanning", async () => {
    const request = await validationRequest();
    request.tables = new Proxy(request.tables, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("tables must not be scanned");
        return Reflect.get(target, property, receiver);
      },
    });
    const controller = new AbortController();
    let telemetryCount = 0;

    await expect(validateMultiTableCandidate(
      request,
      controller.signal,
      resourceOptions(estimates(993), () => {
        telemetryCount += 1;
        controller.abort();
      }),
    )).rejects.toBeInstanceOf(OperationAbortedError);
    expect(telemetryCount).toBe(1);
  });

  it("emits deterministic decision fields once and fails closed on sink errors", async () => {
    const request = await validationRequest();
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];
    const options = resourceOptions(estimates(993), (event) => {
      telemetry.push(event);
    });

    await validateMultiTableCandidate(request, undefined, options);
    await validateMultiTableCandidate(request, undefined, options);

    expect(telemetry).toHaveLength(2);
    expect(deterministicTelemetry(telemetry[0]!)).toEqual(deterministicTelemetry(telemetry[1]!));

    const sinkFailure = new Error("audit storage unavailable");
    await expect(validateMultiTableCandidate(
      request,
      undefined,
      resourceOptions(estimates(993), () => {
        throw sinkFailure;
      }),
    )).rejects.toMatchObject({
      message: "multi-table resource telemetry sink failed",
      cause: sinkFailure,
    });
  });

  it("keeps legacy callers on their unchanged result shape without claiming resource admission", async () => {
    const result = await validateMultiTableCandidate(await validationRequest());

    expect(result.passed).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["checks", "passed"]);
    expect(result.checks.some((item) => item.check_id === "resource_baseline")).toBe(false);
  });
});
