/**
 * M2 straggler + checkpoint-coverage regression tests (audit round 2).
 *
 * - Executor: after a wall-clock operation timeout the build must hold the
 *   build lock until the aborted operation actually settles (bounded grace),
 *   so a timed-out build can never release the lock while the old operation
 *   could still promote a publication behind its failed record.
 * - Canonicalizer: checkpoints count *processed* rows, so an extreme
 *   all-rejected workload still yields to the event loop and honors the
 *   operation timeout / cancel signal.
 * - Integrator: checkpoints count *processed* rows, so an extreme
 *   all-dedup workload still yields (the old code only checkpointed on the
 *   new-unique-row path).
 *
 * The loop-coverage tests are deterministic: a spy counts ``setImmediate``
 * yields.  The parse phase of a 100k-row file yields exactly 12 times
 * (stride 8192); the 13th ``setImmediate`` can only come from the loop's
 * first checkpoint (stride 4096) — i.e. the checkpoint-under-test.  When the
 * count reaches 13 the spy aborts the operation controller *before*
 * delegating to the real ``setImmediate``, so the loop's checkpoint throws
 * ``OperationAbortedError``.  Without the fix the loop never yields again,
 * the abort never fires and the operation completes — the assertion fails.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { parseDatasetExecutionSpec } from "../../src/dataset/contracts/index.js";
import { SOURCE_LONG_COLUMNS } from "../../src/dataset/adapters/index.js";
import {
  buildOperationPlan,
  DatasetExecutionExecutor,
  makeOperationOutput,
  type OperationOutput,
  type OperationSpec,
} from "../../src/dataset/runtime/index.js";
import { parseDataBatch } from "../../src/dataset/contracts/index.js";
import { OperationAbortedError } from "../../src/dataset/cooperative.js";
import { canonicalize, expressionNormalizationV1 } from "../../src/dataset/canonicalizer/index.js";
import { buildGeneExpressionSchema } from "../../src/dataset/schema/index.js";
import { integrate } from "../../src/dataset/integrator/index.js";
import type { CanonicalizationResult } from "../../src/dataset/canonicalizer/index.js";

const ROWS = 100_000;
/** Parse yields every 8192 lines; 100k rows => exactly 12 yields. */
const PARSE_YIELDS = Math.floor(ROWS / 8192);
/** The next setImmediate after the parse belongs to the loop's checkpoint. */
const ABORT_AFTER_CALLS = PARSE_YIELDS + 1;

function scratchRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

afterEach(() => {
  vi.restoreAllMocks();
});

function buildSpec(): ReturnType<typeof parseDatasetExecutionSpec> {
  return parseDatasetExecutionSpec({
    schema_version: "1.0",
    requirement_id: "build_straggler",
    objective: "compare expression",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [
      {
        schema_version: "1.0",
        binding_id: "srcbind_gdc",
        source: "gdc",
        acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
        adapter_id: "gdc.expression.v1",
        accession: "ACC-1",
      },
      {
        schema_version: "1.0",
        binding_id: "srcbind_xena",
        source: "xena",
        acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "xena.files.v1" },
        adapter_id: "xena.expression.v1",
        accession: "ACC-2",
      },
    ],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

describe("M2 straggler safety (audit round 2)", () => {
  test(
    "timeout holds the build lock until the aborted operation settles",
    async () => {
      const root = scratchRoot("straggler-executor-");
      const spec = buildSpec();
      // Every operation completes instantly except parse:srcbind_gdc, which
      // ignores the AbortSignal and keeps running (like a copyFile that
      // cannot be interrupted).  The executor must NOT return as soon as the
      // 50ms timer fires; it must wait for the straggler to settle.
      const runner = (
        op: OperationSpec,
        upstream: Record<string, Record<string, unknown>>,
      ): OperationOutput | Promise<OperationOutput> => {
        if (op.operation_id === "parse:srcbind_gdc") {
          return new Promise((resolve) => {
            setTimeout(() => resolve(makeOperationOutput({ operation_id: op.operation_id })), 400);
          });
        }
        return makeOperationOutput({
          operation_id: op.operation_id,
          upstream: Object.keys(upstream).sort(),
        });
      };
      const executor = new DatasetExecutionExecutor({
        taskId: "task_straggler",
        requirementId: spec.requirement_id,
        stateDir: join(root, "state"),
        taskRoot: root,
        plan: buildOperationPlan(spec),
        runOperation: runner,
        operationTimeoutMs: 50,
      });
      const started = Date.now();
      const outcome = await executor.run();
      const elapsed = Date.now() - started;
      expect(outcome.status).toBe("failed");
      expect(outcome.error?.code).toBe("timeout");
      // Bounded grace: the timeout at ~50ms must not release the lock while
      // the straggler is still running; the run only returns after the
      // straggler settles (~400ms).  Generous lower bound for CI variance.
      expect(elapsed).toBeGreaterThanOrEqual(300);
    },
    30_000,
  );
});

describe("M2 checkpoint coverage for rejection/dedup workloads (audit round 2)", () => {
  /** Count setImmediate yields; abort the controller at the loop's first
   * checkpoint (the call right after the parse phase's last yield). */
  function installYieldSpy(controller: AbortController, abortAfterCalls: number): void {
    const realSetImmediate = globalThis.setImmediate;
    let calls = 0;
    vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: () => void) => {
      calls += 1;
      if (calls === abortAfterCalls) {
        controller.abort();
      }
      return realSetImmediate(callback);
    }) as typeof setImmediate);
  }

  test(
    "canonicalize of an all-rejected workload yields and honors the signal",
    async () => {
      const root = scratchRoot("straggler-canonicalize-");
      const sourcePath = join(root, "all_rejected.csv");
      const header = SOURCE_LONG_COLUMNS.join(",");
      const emptyRow = Array(SOURCE_LONG_COLUMNS.length).fill("").join(",");
      writeFileSync(
        sourcePath,
        `${header}\n${`${emptyRow}\n`.repeat(ROWS)}`,
        "utf8",
      );
      const schema = buildGeneExpressionSchema();
      const columns = schema.fields.map((field) => field.name);
      const checksum = "ab".repeat(32);
      const batch = parseDataBatch({
        schema_version: "1.0",
        batch_id: "batch_binding_1",
        binding_id: "binding_1",
        dataset_family: "gene_expression",
        row_granularity: "gene_sample_measurement",
        schema_ref: "gene_expression.long.v1",
        file_asset: {
          schema_version: "1.0",
          asset_id: `asset_${checksum}`,
          kind: "parsed",
          relative_path: "all_rejected.csv",
          sha256: checksum,
          size_bytes: 1,
          media_type: "text/csv",
          generated_by_step_id: "step_test",
        },
        row_count: ROWS,
        column_count: columns.length,
        parser_id: "test.long.v1",
        parser_version: "1.0.0",
        statistics: {},
        warnings: [],
        declared_mappings: [],
      });
      const controller = new AbortController();
      installYieldSpy(controller, ABORT_AFTER_CALLS);
      await expect(
        canonicalize(
          { batch, schema, profile: expressionNormalizationV1(), outputDir: root },
          controller.signal,
        ),
      ).rejects.toThrow(OperationAbortedError);
    },
    60_000,
  );

  test(
    "integrate of an all-dedup workload yields and honors the signal",
    async () => {
      const root = scratchRoot("straggler-integrate-");
      const canonicalPath = join(root, "canonical_dup.csv");
      const schema = buildGeneExpressionSchema();
      const columns = schema.fields.map((field) => field.name);
      const row = [
        "ENSG00000100000",
        "S1",
        "gene_expression",
        "expression_value",
        "1.0",
        "asset_a",
      ];
      writeFileSync(
        canonicalPath,
        `${columns.join(",")}\n${`${row.join(",")}\n`.repeat(ROWS)}`,
        "utf8",
      );
      const batch = parseDataBatch({
        schema_version: "1.0",
        batch_id: "batch_binding_1",
        binding_id: "binding_1",
        dataset_family: "gene_expression",
        row_granularity: "gene_sample_measurement",
        schema_ref: "gene_expression.long.v1",
        file_asset: null,
        row_count: ROWS,
        column_count: columns.length,
        parser_id: "test.long.v1",
        parser_version: "1.0.0",
        statistics: {},
        warnings: [],
        declared_mappings: [],
      });
      const result: CanonicalizationResult = {
        batch,
        canonicalPath,
        rowCount: ROWS,
        rejectedCount: 0,
        namespaces: ["gene_symbol"],
        auditPaths: [],
      };
      const controller = new AbortController();
      // The streaming read yields 12 times for 100k rows (stride 8192); the
      // next setImmediate can only come from the dedup loop's first
      // checkpoint (stride 4096) — aborting there proves the dedup path
      // itself honors the signal.
      installYieldSpy(controller, ABORT_AFTER_CALLS);
      await expect(
        integrate({
          results: [result],
          mergeStrategy: "append_by_canonical_row",
          schema,
          requirementId: "build_dup",
          outputDir: root,
          signal: controller.signal,
        }),
      ).rejects.toThrow(OperationAbortedError);
      // The interruption must have happened inside the dedup loop, before
      // the merged file was written (sha256FileStream also checks the signal,
      // so without this guard a regression could still reject late and pass).
      expect(existsSync(join(root, "merged", "primary.csv"))).toBe(false);
    },
    60_000,
  );
});
