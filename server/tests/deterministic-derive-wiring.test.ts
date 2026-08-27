import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeterministicDeriveRequest } from "@biomed/contracts";
import {
  computeDeterministicDeriveRequestIdentity,
  DeterministicDeriveRegistry,
  PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
} from "../src/dataset/derive/index.js";
import { parseDatasetExecutionSpec } from "../src/dataset/contracts/index.js";
import {
  buildOperationPlan,
  DatasetExecutionExecutor,
  loadOperationResultManifest,
  makeOperationOutput,
} from "../src/dataset/runtime/index.js";
import { createTsCoreOperationRunner } from "../src/dataset/service/ts-core.js";

function spec() {
  return parseDatasetExecutionSpec({
    schema_version: "1.0",
    requirement_id: "build_derive",
    objective: "derive",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [{
      schema_version: "1.0",
      binding_id: "srcbind_gdc",
      source: "gdc",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
      adapter_id: "gdc.expression.v1",
      accession: "ACC-1",
    }],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

function request(mode: string): DeterministicDeriveRequest {
  const base = {
    schema_version: "1.0" as const,
    slot: "derive" as const,
    request_id: "request_derive",
    task_id: "task_derive",
    requirement_id: "build_derive",
    algorithm_id: PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
    algorithm_version: "1.0.0",
    implementation_digest: "a".repeat(64),
    parameters: { mode },
    reference: { schema_version: "1.0" as const, reference_id: "ref", version: "1", digest: "b".repeat(64) },
    inputs: [{
      schema_version: "1.0" as const,
      input_id: "input",
      kind: "registered_asset" as const,
      digest: "c".repeat(64),
      asset_ref: { schema_version: "1.0" as const, asset_id: `asset_${"c".repeat(64)}`, task_id: "task_derive", role: "source" as const },
      committed_result_ref: null,
    }],
    output_schema_ref: "derived_test.v1",
  };
  return { ...base, request_identity_digest: computeDeterministicDeriveRequestIdentity(base) };
}

describe("fixed deterministic derive runtime slot", () => {
  test("executes a registered handler and invalidates reuse when request identity changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-wiring-"));
    try {
      const buildSpec = spec();
      let executions = 0;
      const registry = new DeterministicDeriveRegistry([{
        algorithmId: PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
        algorithmVersion: "1.0.0",
        implementationDigest: "a".repeat(64),
        derive: () => {
          executions += 1;
          return { outputDigest: "d".repeat(64), outputSummary: { row_count: 1 } };
        },
      }]);
      const capability = registry.createCapability(PDB_INTERFACE_DISTANCE_ALGORITHM_ID, "1.0.0");
      const run = async (deriveRequest: DeterministicDeriveRequest) => {
        const plan = buildOperationPlan(buildSpec, { deriveHandler: true });
        const coreRunner = createTsCoreOperationRunner({
          spec: buildSpec,
          taskId: "task_derive",
          taskRoot: root,
          outputDir: root,
          sourceAssets: {},
          mappingAssets: {},
          metadataAssets: {},
          deriveRequest,
          deriveCapability: capability,
          runnerState: {
            batches: new Map(), canonicalResults: [], integration: null, candidate: null,
            manifest: null, validation: null, publicationId: null,
          },
          bindings: new Map(),
          rehydratedBindingIds: new Set(),
        });
        return new DatasetExecutionExecutor({
          taskId: "task_derive",
          requirementId: buildSpec.requirement_id,
          stateDir: join(root, "state"),
          taskRoot: root,
          plan,
          deriveRequest,
          implementationVersions: { derive: capability.implementationDigest },
          runOperation: (op, upstream, signal, suspension) => op.kind === "derive"
            ? coreRunner(op, upstream, signal, suspension)
            : makeOperationOutput({ operation_id: op.operation_id }),
        }).run();
      };

      expect((await run(request("first"))).status).toBe("completed");
      expect(executions).toBe(1);
      expect(loadOperationResultManifest(join(root, "state"), "derive")).toMatchObject({
        operation_kind: "derive",
        output_kind: "derived_evidence",
        implementation_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect((await run(request("changed"))).status).toBe("completed");
      expect(executions).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stably skips the slot when no handler is registered", () => {
    expect(buildOperationPlan(spec()).some((op) => op.kind === "derive")).toBe(false);
  });
});
