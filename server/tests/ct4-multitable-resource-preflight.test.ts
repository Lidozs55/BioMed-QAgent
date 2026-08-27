import { createHash } from "node:crypto";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  DatasetSchemaV2,
  OperationResultManifest,
  TableDefinition,
} from "@biomed/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MultiTableValidationRequest } from "../src/dataset/contracts/validation.js";
import { OperationAbortedError } from "../src/dataset/cooperative.js";
import {
  DiskIndexResourceLimitError,
  TupleIndex,
  createTupleIndex,
  type Tuple,
} from "../src/dataset/validation/disk-index.js";
import {
  validateMultiTableCandidate,
  type MultiTableB3BackendOptions,
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
    run_id: "run_test",
    requirement_id: "build_ct4",
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
  };
  return {
    task_id: "task_ct4",
    run_id: "run_test",
    requirement_id: "build_ct4",
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

/** Production-shaped factory that creates the real disk TupleIndex. */
function diskFactory(): MultiTableB3BackendOptions["factory"] {
  return {
    factoryId: "test-tuple-index.v1",
    createIndex: async (options) => createTupleIndex({
      mode: "disk",
      owner: { taskId: options.owner.taskId, generation: options.owner.generation },
      directory: options.directory,
      quotaBytes: options.quotaBytes,
      batchSize: options.batchSize,
    }),
  };
}

/** Production B3 backend capability for one Core-owned validation. */
function b3Backend(
  request: MultiTableValidationRequest,
  overrides: Partial<MultiTableB3BackendOptions> = {},
): MultiTableB3BackendOptions {
  return {
    owner: { taskId: request.task_id, requirementId: request.requirement_id, generation: 3 },
    factory: diskFactory(),
    snapshotImmutable: true,
    parityProof: { digest: "ab".repeat(32), ref: "b3-parity/evidence/test-1" },
    cleanup: { ownerId: `b3:${request.task_id}`, cleanup: async () => {} },
    quotaBytesPerIndex: 64 * 1024 * 1024,
    ...overrides,
  };
}

/** Above-threshold options that force the disk decision for one table. */
function diskOptions(
  request: MultiTableValidationRequest,
  telemetrySink: MultiTableValidationOptions["resourceBaseline"]["telemetrySink"],
  overrides: Partial<MultiTableB3BackendOptions> = {},
): MultiTableValidationOptions {
  const policy = {
    ...basePolicy,
    memoryThresholdBytes: 0,
    tempQuotaBytes: 128 * 1024 * 1024,
  };
  const options = resourceOptions(telemetrySink, policy);
  options.resourceBaseline.configuredTempBytes = 128 * 1024 * 1024;
  options.b3Backend = b3Backend(request, overrides);
  return options;
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
  vi.restoreAllMocks();
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

  it("executes the real disk TupleIndex PK path with memory check-order/result parity", async () => {
    const request = await validationRequest("row_id\nduplicate\nduplicate\n");
    const memoryTelemetry: MultiTableResourcePreflightTelemetry[] = [];
    const diskTelemetry: MultiTableResourcePreflightTelemetry[] = [];
    const memoryPolicy = {
      ...basePolicy,
      memoryThresholdBytes: 1_000_000,
      tempQuotaBytes: 128 * 1024 * 1024,
    };
    const memoryOptions = resourceOptions((event) => {
      memoryTelemetry.push(event);
    }, memoryPolicy);
    memoryOptions.resourceBaseline.configuredTempBytes = 128 * 1024 * 1024;
    const memory = await validateMultiTableCandidate(request, resourceSignal(), memoryOptions);

    const createSpy = vi.spyOn(TupleIndex, "create");
    const addBatchSpy = vi.spyOn(TupleIndex.prototype, "addBatch");
    const primaryKeyCheckSpy = vi.spyOn(TupleIndex.prototype, "primaryKeyCheck");
    const cleanupSpy = vi.spyOn(TupleIndex.prototype, "cleanup");
    const disk = await validateMultiTableCandidate(
      request,
      resourceSignal(),
      diskOptions(request, (event) => {
        diskTelemetry.push(event);
      }, {
        owner: { taskId: request.task_id, requirementId: request.requirement_id, generation: 4 },
        batchSize: 2,
      }),
    );

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: "disk",
      owner: { taskId: request.task_id, generation: 4 },
    }));
    expect(addBatchSpy).toHaveBeenCalled();
    expect(primaryKeyCheckSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(memoryTelemetry).toEqual([expect.objectContaining({ validatorMode: "memory" })]);
    expect(diskTelemetry).toEqual([expect.objectContaining({ validatorMode: "disk" })]);
    expect(disk.checks.filter((item) => item.check_id !== "resource_baseline")).toEqual(
      memory.checks.filter((item) => item.check_id !== "resource_baseline"),
    );
    expect(disk.passed).toBe(memory.passed);
    expect(disk.checks.find((item) => item.check_id === "primary_key_uniqueness")).toEqual(
      expect.objectContaining({ passed: false, detail: "1 duplicate primary key value(s); null_or_blank=0" }),
    );
  });

  it("uses the selected disk PK result without falling back to the Map result", async () => {
    const request = await validationRequest();
    const options = diskOptions(request, () => undefined, {
      owner: { taskId: request.task_id, requirementId: request.requirement_id, generation: 5 },
    });
    vi.spyOn(TupleIndex.prototype, "primaryKeyCheck").mockReturnValue({
      duplicateKeys: 7,
      nullOrBlankRows: 0,
      passed: false,
    });

    const result = await validateMultiTableCandidate(request, resourceSignal(), options);

    expect(result.passed).toBe(false);
    expect(result.checks.find((item) => item.check_id === "primary_key_uniqueness")).toEqual(
      expect.objectContaining({ passed: false, detail: "7 duplicate primary key value(s); null_or_blank=0" }),
    );
  });

  it.each([
    ["another task", { taskId: "task_other", requirementId: "build_ct4", generation: 3 }],
    ["another build", { taskId: "task_ct4", requirementId: "build_other", generation: 3 }],
  ])("fails closed on %s before any index creation", async (_label, owner) => {
    const request = await validationRequest();
    const options = diskOptions(request, () => undefined, { owner });
    const createSpy = vi.spyOn(TupleIndex, "create");

    const result = await validateMultiTableCandidate(request, resourceSignal(), options);

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      check_id: "resource_baseline",
      passed: false,
      detail: expect.stringContaining('"backend_reason":"owner_mismatch"'),
    }));
    expect(result.checks.some((item) => item.check_id === "primary_key_uniqueness")).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing parity proof", { parityProof: null }, "parity_proof_missing"],
    ["a mutable snapshot", { snapshotImmutable: false }, "snapshot_mutable"],
    ["missing cleanup", { cleanup: null }, "cleanup_unavailable"],
  ])("fails closed when the backend gate rejects on %s", async (_label, override, reason) => {
    const request = await validationRequest();
    const options = diskOptions(request, () => undefined, override);
    const createSpy = vi.spyOn(TupleIndex, "create");

    const result = await validateMultiTableCandidate(request, resourceSignal(), options);

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      check_id: "resource_baseline",
      passed: false,
      detail: expect.stringContaining(`"backend_reason":"${reason}"`),
    }));
    expect(result.checks.some((item) => item.check_id === "primary_key_uniqueness")).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects cancellation from disk addBatch and cleans the selected index in finally", async () => {
    const request = await validationRequest("row_id\nrow-1\nrow-2\n");
    const controller = new AbortController();
    const options = diskOptions(request, () => undefined, {
      owner: { taskId: request.task_id, requirementId: request.requirement_id, generation: 6 },
    });
    const originalAddBatch = TupleIndex.prototype.addBatch;
    vi.spyOn(TupleIndex.prototype, "addBatch").mockImplementation(async function (
      this: TupleIndex,
      values: Iterable<Tuple>,
      signal?: AbortSignal | null,
    ) {
      controller.abort();
      await originalAddBatch.call(this, values, signal);
    });
    const cleanupSpy = vi.spyOn(TupleIndex.prototype, "cleanup");

    await expect(validateMultiTableCandidate(request, controller.signal, options))
      .rejects.toBeInstanceOf(OperationAbortedError);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a disk quota failure and removes the selected index in finally", async () => {
    const values = Array.from(
      { length: 96 },
      (_, index) => `${index}:${"x".repeat(1_024)}`,
    );
    const request = await validationRequest(`row_id\n${values.join("\n")}\n`);
    const options = diskOptions(request, () => undefined, {
      owner: { taskId: request.task_id, requirementId: request.requirement_id, generation: 7 },
      quotaBytesPerIndex: 32 * 1024,
      batchSize: 128,
    });
    let storagePath: string | null = null;
    const originalCreate = TupleIndex.create.bind(TupleIndex);
    vi.spyOn(TupleIndex, "create").mockImplementation(async (indexOptions) => {
      const index = await originalCreate(indexOptions);
      storagePath = index.storagePath();
      return index;
    });
    const cleanupSpy = vi.spyOn(TupleIndex.prototype, "cleanup");

    await expect(validateMultiTableCandidate(request, resourceSignal(), options))
      .rejects.toBeInstanceOf(DiskIndexResourceLimitError);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    if (storagePath === null) throw new Error("disk index storage path was not captured");
    await expect(access(storagePath)).rejects.toThrow();
  });

  it("keeps legacy callers on their unchanged result shape without claiming resource admission", async () => {
    const result = await validateMultiTableCandidate(await validationRequest());

    expect(result.passed).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["checks", "passed"]);
    expect(result.checks.some((item) => item.check_id === "resource_baseline")).toBe(false);
  });
});
