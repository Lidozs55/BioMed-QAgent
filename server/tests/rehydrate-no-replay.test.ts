/**
 * A5I Increment 3 — checkpoint rehydration without runner replay.
 *
 * Locks the WP-A5 acceptance criteria: after a restart the
 * parse/canonicalize/integrate runners are invoked 0 times for completed
 * operations; a fully completed build restores the publish output from disk;
 * tampered/removed result files fail closed and re-run only the minimal
 * downstream closure.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { parseDatasetBuildSpec, parseSourceAsset, type SourceAsset } from "../src/dataset/contracts/index.js";
import {
  buildOperationPlan,
  BuildCancelledError,
  DatasetBuildExecutor,
  loadOperationResultManifest,
  makeOperationOutput,
  stageOutputFile,
  type OperationOutput,
  type OperationSpec,
} from "../src/dataset/runtime/index.js";

function binding(bindingId: string, source: string): Record<string, unknown> {
  return {
    schema_version: "1.0",
    binding_id: bindingId,
    source,
    acquisition: {
      schema_version: "1.0",
      mode: "builtin",
      provider_id: `${source}.files.v1`,
    },
    adapter_id: `${source}.expression.v1`,
    accession: "ACC-1",
  };
}

function spec() {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: "build_test",
    objective: "compare expression",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [binding("srcbind_gdc", "gdc"), binding("srcbind_xena", "xena")],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

function sourceAsset(name: string, sha256: string): SourceAsset {
  return parseSourceAsset({
    schema_version: "1.0",
    asset_id: `asset_${sha256}`,
    kind: "source",
    relative_path: `source_assets/${name}.csv`,
    sha256,
    size_bytes: 0,
    media_type: "text/csv",
    generated_by_step_id: null,
    source_id: `source_${name}`,
    successful_attempt_id: `attempt_${name}`,
    derived_from_asset_id: null,
    data_level: "repository_processed",
  });
}

class RecordingRunner {
  readonly calls: string[] = [];
  run = (op: OperationSpec, upstream: Record<string, Record<string, unknown>>): OperationOutput => {
    this.calls.push(op.operation_id);
    return makeOperationOutput({
      operation_id: op.operation_id,
      kind: op.kind,
      upstream: Object.keys(upstream).sort(),
    });
  };
}

/** Cancels once when the integrate operation starts (partial-resume fixture). */
class CancelAtIntegrateRunner extends RecordingRunner {
  private cancelled = false;
  run = (op: OperationSpec, upstream: Record<string, Record<string, unknown>>): OperationOutput => {
    this.calls.push(op.operation_id);
    if (op.operation_id === "integrate" && !this.cancelled) {
      this.cancelled = true;
      throw new BuildCancelledError("interrupt at integrate for partial-resume test");
    }
    return makeOperationOutput({
      operation_id: op.operation_id,
      kind: op.kind,
      upstream: Object.keys(upstream).sort(),
    });
  };
}

/** Stages a real canonical table file so file-receipt verification applies. */
class CanonicalFileRunner extends RecordingRunner {
  constructor(private readonly root: string) {
    super();
  }
  run = (op: OperationSpec, upstream: Record<string, Record<string, unknown>>): OperationOutput => {
    this.calls.push(op.operation_id);
    if (op.kind === "canonicalize") {
      const fileName = `canonical_${op.category}.csv`;
      const content = "probe\tsymbol\tvalue\nPROBE1\tTP53\t1.5\n";
      writeFileSync(join(this.root, fileName), content, "utf8");
      const sha256 = createHash("sha256").update(content).digest("hex");
      return makeOperationOutput(
        {
          operation_id: op.operation_id,
          kind: op.kind,
          binding_id: op.category,
          row_count: 1,
          file: fileName,
          rejected_count: 0,
          upstream: Object.keys(upstream).sort(),
        },
        [stageOutputFile(fileName, Buffer.byteLength(content, "utf8"), sha256)],
      );
    }
    return makeOperationOutput({
      operation_id: op.operation_id,
      kind: op.kind,
      upstream: Object.keys(upstream).sort(),
    });
  };
}

function makeExecutor(options: {
  outputRoot: string;
  runner: RecordingRunner;
  sourceAssets?: Readonly<Record<string, SourceAsset>> | null;
  implementationVersions?: Record<string, string> | null;
  rehydrateCompletedRunners?: boolean;
}): DatasetBuildExecutor {
  const buildSpec = spec();
  return new DatasetBuildExecutor({
    taskId: "task_1",
    buildId: buildSpec.build_id,
    stateDir: join(options.outputRoot, "state"),
    taskRoot: options.outputRoot,
    plan: buildOperationPlan(buildSpec),
    runOperation: options.runner.run,
    cancellationRequested: null,
    parameterScope: null,
    implementationVersions: options.implementationVersions ?? null,
    sourceAssets: options.sourceAssets ?? null,
    rehydrateCompletedRunners: options.rehydrateCompletedRunners ?? false,
  });
}

describe("A5I Increment 3 rehydration without runner replay", () => {
  test("fully completed build: second run never calls the runner again", async () => {
    const root = mkdtempSync(join(tmpdir(), "rehydrate-"));
    try {
      const sourceAssets = {
        srcbind_gdc: sourceAsset("gdc", "a".repeat(64)),
        srcbind_xena: sourceAsset("xena", "b".repeat(64)),
      };
      const first = new RecordingRunner();
      const ex1 = makeExecutor({ outputRoot: root, runner: first, sourceAssets, rehydrateCompletedRunners: true });
      const fullRun = await ex1.run();
      expect(fullRun.status).toBe("completed");
      expect(first.calls.length).toBe(11);

      const second = new RecordingRunner();
      const ex2 = makeExecutor({ outputRoot: root, runner: second, sourceAssets, rehydrateCompletedRunners: true });
      const outcome = await ex2.run();
      expect(outcome.status).toBe("completed");
      expect(second.calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("partial resume: completed parse/canonicalize/integrate runners are invoked 0 times", async () => {
    const root = mkdtempSync(join(tmpdir(), "rehydrate-partial-"));
    try {
      const first = new CancelAtIntegrateRunner();
      const ex1 = makeExecutor({ outputRoot: root, runner: first, rehydrateCompletedRunners: true });
      const interrupted = await ex1.run();
      expect(interrupted.status).toBe("cancelled");
      expect(first.calls).toContain("integrate");

      const second = new RecordingRunner();
      const ex2 = makeExecutor({ outputRoot: root, runner: second, rehydrateCompletedRunners: true });
      const outcome = await ex2.run();
      expect(outcome.status).toBe("completed");
      expect(second.calls).toEqual(["integrate", "assemble", "validate_profile", "publish"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fully completed build: publish output and result manifest restore from disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "rehydrate-full-"));
    try {
      const first = new RecordingRunner();
      const ex1 = makeExecutor({ outputRoot: root, runner: first, rehydrateCompletedRunners: true });
      expect((await ex1.run()).status).toBe("completed");

      const second = new RecordingRunner();
      const ex2 = makeExecutor({ outputRoot: root, runner: second, rehydrateCompletedRunners: true });
      const outcome = await ex2.run();
      expect(outcome.status).toBe("completed");

      const publishOutput = ex2.getOutput("publish");
      expect(publishOutput).toBeDefined();
      expect(publishOutput).toMatchObject({ operation_id: "publish", kind: "publish" });
      expect(loadOperationResultManifest(join(root, "state"), "publish")).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tampered canonicalize output file: fail closed and re-run only its downstream closure", async () => {
    const root = mkdtempSync(join(tmpdir(), "rehydrate-tamper-"));
    try {
      const stateDir = join(root, "state");
      const first = new CanonicalFileRunner(root);
      const ex1 = makeExecutor({ outputRoot: root, runner: first, rehydrateCompletedRunners: true });
      expect((await ex1.run()).status).toBe("completed");

      const manifest = loadOperationResultManifest(stateDir, "canonicalize:srcbind_xena");
      expect(manifest).not.toBeNull();
      const target = join(root, ...manifest!.output_files[0].relative_path.split("/"));
      writeFileSync(target, readFileSync(target, "utf8").slice(0, 16));

      const second = new CanonicalFileRunner(root);
      const ex2 = makeExecutor({ outputRoot: root, runner: second, rehydrateCompletedRunners: true });
      const outcome = await ex2.run();
      expect(outcome.status).toBe("completed");
      expect(second.calls).toContain("canonicalize:srcbind_xena");
      expect(second.calls).not.toContain("parse:srcbind_gdc");
      expect(second.calls).not.toContain("canonicalize:srcbind_gdc");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
