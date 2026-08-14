/**
 * M2 I-03/I-04 closure: the REAL TypeScript Dataset Core operations — not a
 * fake async runner — are preemptible by wall-clock operation timeout and by
 * cancel (HTTP AbortSignal and the build-lock-scoped ``cancelDatasetBuild``
 * path).
 *
 * The deterministic chain is cooperative by design: heavy sections (adapter
 * parse, canonicalize, integrate, validation, publish) run through
 * ``node:fs/promises``/streams and yield to the event loop every N rows,
 * re-checking the operation AbortSignal.  A large GDC matrix parse takes
 * well over a second here, so a 150 ms wall-clock budget or a 60 ms cancel
 * can never complete it — the assertions are deterministic on any machine.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseDatasetBuildSpec,
  parseSourceAsset,
  type SourceAsset,
} from "../../src/dataset/contracts/index.js";
import { TypeScriptDatasetCore } from "../../src/dataset/service/ts-core.js";
import type { CoreOperationEvent } from "../../src/dataset/runtime/executor.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** GDC-style wide matrix rows whose parse takes ~0.4-1 s on any machine. */
const LARGE_ROWS = 200_000;

function largeGdcMatrix(): Buffer {
  const parts: string[] = ["gene_id\tS1\tS2\tS3\r\n"];
  for (let index = 0; index < LARGE_ROWS; index += 1) {
    parts.push(`ENSG00000141510.${index}\t1.5\t2.5\t3.5\r\n`);
  }
  return Buffer.from(parts.join(""), "utf8");
}

function spec(buildId: string): ReturnType<typeof parseDatasetBuildSpec> {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: buildId,
    objective: "preemptible real core operations",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [{
      schema_version: "1.0",
      binding_id: "binding_gdc",
      source: "gdc",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
      adapter_id: "gdc.expression.v1",
    }],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

async function newCore(options: {
  operationTimeoutMs?: number;
} = {}): Promise<{
  taskRoot: string;
  core: TypeScriptDatasetCore;
  events: Array<{ event: CoreOperationEvent; buildId: string }>;
}> {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-preempt-"));
  roots.push(taskRoot);
  const events: Array<{ event: CoreOperationEvent; buildId: string }> = [];
  const core = new TypeScriptDatasetCore({
    taskId: "task_preempt",
    taskRoot,
    operationTimeoutMs: options.operationTimeoutMs ?? 0,
    eventSink: async (event, buildId) => {
      events.push({ event, buildId });
    },
  });
  return { taskRoot, core, events };
}

async function installSource(
  taskRoot: string,
  bytes: Buffer,
): Promise<SourceAsset> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const destination = path.join(
    taskRoot,
    "source_assets",
    `asset_${sha256}`,
    "gdc_matrix_large.tsv",
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return parseSourceAsset({
    schema_version: "1.0",
    asset_id: `asset_${sha256}`,
    kind: "source",
    relative_path: `source_assets/asset_${sha256}/gdc_matrix_large.tsv`,
    sha256,
    size_bytes: bytes.length,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
    source_id: "src_gdc",
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
  });
}

/** Poll until the parse operation started, so cancels land deterministically
 * mid-operation regardless of machine load (the event sink emits
 * ``operation_started`` before the operation body runs). */
async function waitForParseStarted(
  events: Array<{ event: CoreOperationEvent; buildId: string }>,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (
    !events.some(
      ({ event }) =>
        event.type === "operation_started" &&
        event.operationId === "parse:binding_gdc",
    )
  ) {
    if (Date.now() > deadline) {
      throw new Error("parse operation never started");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("real Core operation preemption (M2 I-03/I-04)", () => {
  it("interrupts a real adapter parse with a typed wall-clock timeout", async () => {
    const { taskRoot, core, events } = await newCore({ operationTimeoutMs: 150 });
    const asset = await installSource(taskRoot, largeGdcMatrix());
    const record = await core.executeDatasetBuild(spec("build_timeout"), {
      runId: "run_timeout",
      sourceAssets: { binding_gdc: asset },
    });
    // With a synchronous parse the build would COMPLETE before the timer
    // could fire; the cooperative chain aborts at the next checkpoint and
    // the executor records the typed timeout failure.
    expect(record.status).toBe("failed");
    expect(record.error).toContain("timed out after 150ms");
    const kinds = events.map(({ event }) => event.type);
    expect(kinds).toContain("operation_failed");
    expect(kinds).toContain("build_failed");
    // No publication may exist for a timed-out build.
    expect(record.publication_id).toBeNull();
  });

  it("interrupts a real adapter parse when the HTTP AbortSignal fires", async () => {
    const { taskRoot, core, events } = await newCore();
    const asset = await installSource(taskRoot, largeGdcMatrix());
    const controller = new AbortController();
    const promise = core.executeDatasetBuild(spec("build_cancel"), {
      runId: "run_cancel",
      sourceAssets: { binding_gdc: asset },
      signal: controller.signal,
    });
    await waitForParseStarted(events);
    controller.abort();
    const record = await promise;
    expect(record.status).toBe("cancelled");
    expect(record.publication_id).toBeNull();
    const kinds = events.map(({ event }) => event.type);
    expect(kinds).toContain("build_cancelled");
  });

  it("interrupts a real adapter parse via cancelDatasetBuild (activeCancels)", async () => {
    const { taskRoot, core, events } = await newCore();
    const asset = await installSource(taskRoot, largeGdcMatrix());
    const promise = core.executeDatasetBuild(spec("build_cancel_active"), {
      runId: "run_cancel_active",
      sourceAssets: { binding_gdc: asset },
    });
    await waitForParseStarted(events);
    core.cancelDatasetBuild("build_cancel_active");
    const record = await promise;
    expect(record.status).toBe("cancelled");
    expect(record.publication_id).toBeNull();
    const kinds = events.map(({ event }) => event.type);
    expect(kinds).toContain("build_cancelled");
    // A cancelled build must not leave a reusable "succeeded" attempt for
    // the interrupted operation: acquire may legitimately succeed before the
    // cancel lands, but the parse that was in flight when the cancel fired
    // must be recorded as cancelled (digest-matched reuse only honours
    // SUCCEEDED, so a later rerun re-parses instead of resurrecting a
    // half-finished batch).
    const stateAttemptsPath = path.join(
      taskRoot,
      "datasets_build",
      "build_cancel_active",
      "state",
      "operation_attempts.jsonl",
    );
    const { readFile } = await import("node:fs/promises");
    const attempts = (await readFile(stateAttemptsPath, "utf8")).trim().split("\n");
    const parseAttempts = attempts.filter((line) =>
      line.includes('"operation_id":"parse:binding_gdc"'),
    );
    expect(parseAttempts.length).toBeGreaterThan(0);
    expect(parseAttempts.some((line) => line.includes('"status":"succeeded"'))).toBe(false);
    expect(parseAttempts.some((line) => line.includes('"status":"cancelled"'))).toBe(true);
  });
});
