/**
 * A5I Increment 2 — typed ADR-030 operation result manifests.
 *
 * Verifies that the CRT executor writes a strict-contract-valid
 * ``OperationResultManifest`` (native mode + committed receipt) on every
 * freshly succeeded operation, that the manifests round-trip through the
 * strict parser, that dependency closures reference the deterministic
 * upstream manifest ids / input asset ids, and that digest-matched reuse
 * never rewrites a manifest.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDatasetBuildSpec, parseSourceAsset, type SourceAsset } from "../src/dataset/contracts/index.js";
import { sha256Json } from "../src/dataset/runtime/digests.js";
import {
  buildOperationPlan,
  DatasetBuildExecutor,
  loadBuildState,
  loadOperationResultManifest,
  makeOperationOutput,
  type OperationOutput,
  type OperationSpec,
} from "../src/dataset/runtime/index.js";

function scratchOutputRoot(prefix = "manifest-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return root;
}

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

function makeExecutor(options: {
  outputRoot: string;
  runner: RecordingRunner;
  sourceAssets?: Readonly<Record<string, SourceAsset>> | null;
  implementationVersions?: Record<string, string> | null;
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
  });
}

const EXPECTED_OUTPUT_KINDS: Record<string, string> = {
  "acquire:srcbind_gdc": "source_asset",
  "acquire:srcbind_xena": "source_asset",
  "parse:srcbind_gdc": "parsed_table",
  "parse:srcbind_xena": "parsed_table",
  "canonicalize:srcbind_gdc": "canonical_table",
  "canonicalize:srcbind_xena": "canonical_table",
  compatibility_gate: "compatibility_report",
  integrate: "integrated_table",
  assemble: "publication_candidate",
  validate_profile: "validation_result",
  publish: "publication_manifest",
};

const DEPENDENCY_UPSTREAMS: Record<string, readonly string[]> = {
  "acquire:srcbind_gdc": [],
  "acquire:srcbind_xena": [],
  "parse:srcbind_gdc": ["acquire:srcbind_gdc"],
  "parse:srcbind_xena": ["acquire:srcbind_xena"],
  "canonicalize:srcbind_gdc": ["parse:srcbind_gdc"],
  "canonicalize:srcbind_xena": ["parse:srcbind_xena"],
  compatibility_gate: ["canonicalize:srcbind_gdc", "canonicalize:srcbind_xena"],
  integrate: ["compatibility_gate"],
  assemble: ["integrate"],
  validate_profile: ["assemble"],
  publish: ["validate_profile"],
};

describe("A5I Increment 2 operation result manifests", () => {
  test("every succeeded operation writes a strict-valid manifest", async () => {
    const outputRoot = scratchOutputRoot("write-all-");
    const stateDir = join(outputRoot, "state");
    const sourceAssets = {
      srcbind_gdc: sourceAsset("gdc", "a".repeat(64)),
      srcbind_xena: sourceAsset("xena", "b".repeat(64)),
    };
    const runner = new RecordingRunner();
    const executor = makeExecutor({ outputRoot, runner, sourceAssets });
    const outcome = await executor.run();
    expect(outcome.status).toBe("completed");
    expect(runner.calls.length).toBe(11);

    const state = loadBuildState(stateDir, "task_1", "build_test");
    const expectedAssetIds = Object.values(sourceAssets)
      .map((asset) => asset.asset_id)
      .sort();

    for (const opId of Object.keys(EXPECTED_OUTPUT_KINDS)) {
      const manifest = loadOperationResultManifest(stateDir, opId);
      expect(manifest).not.toBeNull();
      const m = manifest!;

      expect(m.schema_version).toBe("1.0");
      expect(m.task_id).toBe("task_1");
      expect(m.build_id).toBe("build_test");
      expect(m.operation_id).toBe(opId);
      expect(m.status).toBe("succeeded");
      expect(m.attempt).toBeGreaterThanOrEqual(1);
      expect(m.output_digest).toBe(state.completed_operations[opId]);
      expect(m.output_kind).toBe(EXPECTED_OUTPUT_KINDS[opId]);
      expect(m.result_manifest_id).toBe(
        sha256Json({
          task_id: "task_1",
          build_id: "build_test",
          operation_id: m.operation_id,
          operation_attempt_id: m.operation_attempt_id,
        }),
      );
      expect(m.commit).toEqual({
        state: "committed",
        commit_id: sha256Json({
          result_manifest_id: m.result_manifest_id,
          committed_at: m.commit.committed_at,
        }),
        committed_at: m.commit.committed_at,
      });
      expect(Number.isNaN(Date.parse(m.commit.committed_at))).toBe(false);
      expect(m.migration).toEqual({
        mode: "native",
        legacy_checkpoint_path: null,
        migrated_at: null,
      });
      expect(m.dependency_closure.parameter_digest).toBe(m.parameter_digest);
      expect(m.dependency_closure.implementation_digest).toBe(m.implementation_digest);
      expect(m.dependency_closure.input_asset_ids).toEqual(expectedAssetIds);

      const upstream = DEPENDENCY_UPSTREAMS[opId] ?? [];
      const upstreamManifestIds = upstream
        .map((upstreamId) => loadOperationResultManifest(stateDir, upstreamId)?.result_manifest_id)
        .filter((id): id is string => id !== undefined);
      expect(m.dependency_closure.upstream_result_manifest_ids).toEqual(upstreamManifestIds);
    }
  });

  test("reuse never rewrites an existing result manifest", async () => {
    const outputRoot = scratchOutputRoot("reuse-");
    const stateDir = join(outputRoot, "state");
    const runner1 = new RecordingRunner();
    const first = await makeExecutor({ outputRoot, runner: runner1 }).run();
    expect(first.status).toBe("completed");

    const before = new Map<string, string>();
    for (const opId of Object.keys(EXPECTED_OUTPUT_KINDS)) {
      before.set(opId, readFileSync(join(stateDir, `${opId.replace(/:/g, "_")}_result.json`), "utf8"));
    }

    const runner2 = new RecordingRunner();
    const second = await makeExecutor({ outputRoot, runner: runner2 }).run();
    expect(second.status).toBe("completed");
    expect(runner2.calls).toEqual([]);

    for (const opId of Object.keys(EXPECTED_OUTPUT_KINDS)) {
      const after = readFileSync(join(stateDir, `${opId.replace(/:/g, "_")}_result.json`), "utf8");
      expect(after).toBe(before.get(opId));
    }

    rmSync(outputRoot, { recursive: true, force: true });
  });
});