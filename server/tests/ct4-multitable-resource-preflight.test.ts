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
import type { ResourceBaselinePolicy } from "../src/dataset/validation/resource-baseline.js";

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

const basePolicy: ResourceBaselinePolicy = {
  policyId: "ct4-validator-test-policy",
  // One measured row costs 10 row bytes + 18 UTF-16 tuple payload bytes +
  // 5 key-entry bytes + 2 tuple-field bytes = 35 bytes.
  memoryThresholdBytes: 35,
  heapQuotaBytes: 2_000,
  tempQuotaBytes: 10_000,
  rowOverheadBytes: 10,
  keyEntryOverheadBytes: 5,
  tupleFieldOverheadBytes: 2,
  maxRowCharacters: 4_096,
  maxFieldCharacters: 2_048,
};

function resourceOptions(
  telemetrySink: MultiTableValidationOptions["resourceBaseline"]["telemetrySink"],
  policy: ResourceBaselinePolicy = basePolicy,
): MultiTableValidationOptions {
  return {
    resourceBaseline: {
      policy,
      configuredHeapBytes: 2_000,
      configuredTempBytes: 10_000,
      telemetrySink,
    },
  };
}

async function validationRequest(content = "row_id\nrow-1\n"): Promise<MultiTableValidationRequest> {
  const trustedRoot = await mkdtemp(path.join(os.tmpdir(), "ct4-preflight-trusted-"));
  const forbiddenRoot = await mkdtemp(path.join(os.tmpdir(), "ct4-preflight-forbidden-"));
  roots.push(trustedRoot, forbiddenRoot);
  const relativePath = "rows.csv";
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

function resourceSignal(): AbortSignal {
  return new AbortController().signal;
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

describe("C-T4 multi-table measured resource preflight", () => {
  it("admits the exact measured memory threshold and binds telemetry to Core receipts", async () => {
    const request = await validationRequest();
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];

    const result = await validateMultiTableCandidate(
      request,
      resourceSignal(),
      resourceOptions((event) => {
        telemetry.push(event);
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      check_id: "resource_baseline",
      passed: true,
    }));
    expect(telemetry).toHaveLength(1);
    expect(deterministicTelemetry(telemetry[0]!)).toEqual({
      schemaVersion: "b3-multitable-resource-preflight.v2",
      measurementSource: "core_receipted_table_scan.v1",
      validatorMode: "memory",
      thresholdBasis: {
        policyId: basePolicy.policyId,
        memoryThresholdBytes: 35,
        policyHeapQuotaBytes: 2_000,
        configuredHeapBytes: 2_000,
        effectiveMemoryThresholdBytes: 35,
        policyTempQuotaBytes: 10_000,
        configuredTempBytes: 10_000,
        effectiveTempQuotaBytes: 10_000,
      },
      measuredInputs: [{
        tableId: "rows",
        resultManifestId: "result_ct4_rows",
        relativePath: "rows.csv",
        sizeBytes: 13,
        sha256: createHash("sha256").update("row_id\nrow-1\n").digest("hex"),
      }],
      measurementComplete: true,
      rowEstimate: 1,
      keyEstimates: [{
        keyId: '["rows",["row_id"]]',
        entryEstimate: 1,
        tupleWidthEstimateBytes: 18,
        tupleFieldCount: 1,
      }],
      configuredHeapBytes: 2_000,
      configuredTempBytes: 10_000,
      estimatedHeapBytes: 35,
      estimatedTempBytes: 35,
      tempBytes: null,
      failureReason: null,
    });
  });

  it("rejects the first measured byte above memory before building key maps", async () => {
    const request = await validationRequest();
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];
    const belowMeasuredSize = { ...basePolicy, memoryThresholdBytes: 34 };

    const result = await validateMultiTableCandidate(
      request,
      resourceSignal(),
      resourceOptions((event) => {
        telemetry.push(event);
      }, belowMeasuredSize),
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      check_id: "resource_baseline",
      passed: false,
      detail: expect.stringContaining('"failure_reason":"disk_unavailable"'),
    }));
    expect(result.checks.some((item) => item.check_id === "primary_key_uniqueness")).toBe(false);
    expect(result.checks.some((item) => item.check_id === "data_type")).toBe(false);
    expect(telemetry[0]).toEqual(expect.objectContaining({
      validatorMode: "reject",
      rowEstimate: 1,
      estimatedHeapBytes: 35,
      failureReason: "disk_unavailable",
    }));
  });

  it("ignores forged caller estimates and derives a larger input from receipted bytes", async () => {
    const request = await validationRequest("row_id\nrow-1\nrow-2\n");
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];
    const optionsWithForgedEstimates = {
      ...resourceOptions((event) => {
        telemetry.push(event);
      }),
      estimates: {
        rowEstimate: 0,
        keyEstimates: [],
        configuredHeapBytes: 2_000,
        configuredTempBytes: 10_000,
      },
    };

    const result = await validateMultiTableCandidate(
      request,
      resourceSignal(),
      optionsWithForgedEstimates,
    );

    expect(result.passed).toBe(false);
    expect(telemetry[0]).toEqual(expect.objectContaining({
      measurementSource: "core_receipted_table_scan.v1",
      measurementComplete: true,
      rowEstimate: 2,
      keyEstimates: [expect.objectContaining({ entryEstimate: 2 })],
      estimatedHeapBytes: 70,
      failureReason: "disk_unavailable",
    }));
  });

  it("requires cancellation capability before inspecting resource-gated tables", async () => {
    const request = await validationRequest();
    request.tables = new Proxy(request.tables, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("table input must not be inspected");
        return Reflect.get(target, property, receiver);
      },
    });
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];

    const result = await validateMultiTableCandidate(
      request,
      undefined,
      resourceOptions((event) => {
        telemetry.push(event);
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual([expect.objectContaining({
      check_id: "resource_baseline",
      passed: false,
      detail: expect.stringContaining('"failure_reason":"cancel_unavailable"'),
    })]);
    expect(telemetry).toEqual([expect.objectContaining({
      measurementSource: "configuration_precheck.v1",
      measurementComplete: false,
      failureReason: "cancel_unavailable",
    })]);
  });

  it("rejects invalid resource configuration before inspecting table inputs", async () => {
    const request = await validationRequest();
    request.tables = new Proxy(request.tables, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("table input must not be inspected");
        return Reflect.get(target, property, receiver);
      },
    });
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];
    const invalidPolicy = { ...basePolicy, maxFieldCharacters: 0 };

    const result = await validateMultiTableCandidate(
      request,
      resourceSignal(),
      resourceOptions((event) => {
        telemetry.push(event);
      }, invalidPolicy),
    );

    expect(result).toEqual({
      passed: false,
      checks: [expect.objectContaining({
        check_id: "resource_baseline",
        passed: false,
        detail: expect.stringContaining('"failure_reason":"invalid_policy"'),
      })],
    });
    expect(telemetry).toEqual([expect.objectContaining({
      measurementSource: "configuration_precheck.v1",
      measuredInputs: [],
      measurementComplete: false,
      rowEstimate: null,
      failureReason: "invalid_policy",
    })]);
  });

  it("fails bounded measurement on an oversized row and emits rejection telemetry", async () => {
    const oversized = `row_id\n${"x".repeat(8_192)}`;
    const request = await validationRequest(oversized);
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];

    const result = await validateMultiTableCandidate(
      request,
      resourceSignal(),
      resourceOptions((event) => {
        telemetry.push(event);
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      check_id: "resource_measurement",
      passed: false,
      detail: expect.stringContaining("exceeds 4096 chars"),
    }));
    expect(telemetry).toEqual([expect.objectContaining({
      measurementSource: "core_receipted_table_scan.v1",
      validatorMode: "reject",
      measuredInputs: [],
      measurementComplete: false,
      rowEstimate: null,
      failureReason: "measurement_failed",
    })]);
  });

  it("honors AbortSignal after measured telemetry and before key-map scanning", async () => {
    const request = await validationRequest();
    const controller = new AbortController();
    let telemetryCount = 0;

    await expect(validateMultiTableCandidate(
      request,
      controller.signal,
      resourceOptions(() => {
        telemetryCount += 1;
        controller.abort();
      }),
    )).rejects.toBeInstanceOf(OperationAbortedError);
    expect(telemetryCount).toBe(1);
  });

  it("emits deterministic measured decision fields and fails closed on sink errors", async () => {
    const request = await validationRequest();
    const telemetry: MultiTableResourcePreflightTelemetry[] = [];
    const options = resourceOptions((event) => {
      telemetry.push(event);
    });

    await validateMultiTableCandidate(request, resourceSignal(), options);
    await validateMultiTableCandidate(request, resourceSignal(), options);

    expect(telemetry).toHaveLength(2);
    expect(deterministicTelemetry(telemetry[0]!)).toEqual(deterministicTelemetry(telemetry[1]!));

    const sinkFailure = new Error("audit storage unavailable");
    await expect(validateMultiTableCandidate(
      request,
      resourceSignal(),
      resourceOptions(() => {
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
