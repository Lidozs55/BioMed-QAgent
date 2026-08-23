/**
 * Deterministic C-T11 memory/disk parity fixture: two tables with one
 * many_to_one FK relation, one missing referenced key and one duplicated FK
 * value. Both memory and disk modes must produce the same checks in the same
 * order with the same digest. Shared by the parity test and the committed
 * evidence generator (b3-memory-disk-parity.gen.run.ts).
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  DatasetSchemaV2,
  OperationResultManifest,
  TableDefinition,
} from "@biomed/contracts";

import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import type { MultiTableValidationCheck, MultiTableValidationRequest } from "../src/dataset/contracts/validation.js";
import { createTupleIndex } from "../src/dataset/validation/disk-index.js";
import {
  validateMultiTableCandidate,
  type MultiTableB3BackendOptions,
  type MultiTableValidationOptions,
} from "../src/dataset/validation/multitable.js";
import type { ResourceBaselinePolicy } from "../src/dataset/validation/resource-baseline.js";

const DIGEST = "0".repeat(64);

export const PARENTS_CSV = "parent_id\np1\np2\n";
export const CHILDREN_CSV = "child_id,parent_id\nc1,p1\nc2,p1\nc3,p9\n";

export const parentsSchema: DatasetSchemaV2 = {
  schema_version: "2.0",
  schema_id: "parity.parents.v1",
  dataset_family: "parity_fixture",
  row_granularity: "parent_row",
  primary_key: ["parent_id"],
  fields: [{
    schema_version: "2.0",
    name: "parent_id",
    data_type: "string",
    semantic_role: "identifier",
    required: true,
    nullable: false,
    unit_policy: null,
    ontology: null,
    description: "parent identifier",
    derivation_policy: null,
  }],
};

export const childrenSchema: DatasetSchemaV2 = {
  schema_version: "2.0",
  schema_id: "parity.children.v1",
  dataset_family: "parity_fixture",
  row_granularity: "child_row",
  primary_key: ["child_id"],
  fields: [
    {
      schema_version: "2.0",
      name: "child_id",
      data_type: "string",
      semantic_role: "identifier",
      required: true,
      nullable: false,
      unit_policy: null,
      ontology: null,
      description: "child identifier",
      derivation_policy: null,
    },
    {
      schema_version: "2.0",
      name: "parent_id",
      data_type: "string",
      semantic_role: "relation",
      required: true,
      nullable: false,
      unit_policy: null,
      ontology: null,
      description: "referenced parent identifier",
      derivation_policy: null,
    },
  ],
};

export const parentsDefinition: TableDefinition = {
  table_id: "parents",
  schema_ref: parentsSchema.schema_id,
  role: "primary",
  required: true,
  allow_empty: false,
  primary_key: ["parent_id"],
  field_names: ["parent_id"],
};

export const childrenDefinition: TableDefinition = {
  table_id: "children",
  schema_ref: childrenSchema.schema_id,
  role: "supporting",
  required: true,
  allow_empty: false,
  primary_key: ["child_id"],
  field_names: ["child_id", "parent_id"],
};

export const parityPolicy: ResourceBaselinePolicy = {
  policyId: "b3-parity-fixture-policy",
  memoryThresholdBytes: 1_000_000,
  heapQuotaBytes: 2_000_000,
  tempQuotaBytes: 256 * 1024 * 1024,
  rowOverheadBytes: 10,
  keyEntryOverheadBytes: 5,
  tupleFieldOverheadBytes: 2,
  maxRowCharacters: 4_096,
  maxFieldCharacters: 2_048,
};

async function operationResult(
  taskId: string,
  buildId: string,
  manifestId: string,
  trustedRoot: string,
  relativePath: string,
  content: string,
): Promise<OperationResultManifest> {
  const filePath = path.join(trustedRoot, relativePath);
  await writeFile(filePath, content, "utf8");
  const fileStat = await stat(filePath);
  return {
    schema_version: "1.0",
    result_manifest_id: manifestId,
    task_id: taskId,
    build_id: buildId,
    operation_id: `integrate_${manifestId}`,
    operation_kind: "integrate",
    operation_attempt_id: `attempt_${manifestId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: DIGEST,
    parameter_digest: DIGEST,
    implementation_digest: DIGEST,
    output_digest: createHash("sha256").update(manifestId).digest("hex"),
    output_kind: "integrated_table",
    output_summary: {},
    output_files: [{
      relative_path: relativePath,
      size_bytes: fileStat.size,
      sha256: createHash("sha256").update(content).digest("hex"),
    }],
    dependency_closure: {
      input_asset_ids: [],
      upstream_result_manifest_ids: [],
      parameter_digest: DIGEST,
      implementation_digest: DIGEST,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${manifestId}`,
      committed_at: "2026-08-23T00:00:00Z",
    },
    migration: {
      mode: "native",
      legacy_checkpoint_path: null,
      migrated_at: null,
    },
  };
}

export async function parityRequest(): Promise<{
  request: MultiTableValidationRequest;
  trustedRoot: string;
}> {
  const taskId = "task_parity";
  const buildId = "build_parity";
  const trustedRoot = await mkdtemp(path.join(os.tmpdir(), "b3-parity-trusted-"));
  const forbiddenRoot = await mkdtemp(path.join(os.tmpdir(), "b3-parity-forbidden-"));
  const parents = await operationResult(
    taskId, buildId, "result_parity_parents", trustedRoot, "parents.csv", PARENTS_CSV,
  );
  const children = await operationResult(
    taskId, buildId, "result_parity_children", trustedRoot, "children.csv", CHILDREN_CSV,
  );
  const request: MultiTableValidationRequest = {
    task_id: taskId,
    build_id: buildId,
    candidate: {
      candidate_id: "candidate_parity",
      table_ids: [parentsDefinition.table_id, childrenDefinition.table_id],
      relation_ids: ["children_parent"],
      provenance_refs: ["prov_parents", "prov_children"],
      confidence_refs: ["conf_parents", "conf_children"],
      audit_refs: [],
    },
    tables: [
      {
        definition: parentsDefinition,
        schema: parentsSchema,
        file: {
          origin: "core_operation_result",
          relative_path: "parents.csv",
          delimiter: ",",
          operation_result: parents,
        },
        provenance_refs: ["prov_parents"],
        confidence_refs: ["conf_parents"],
      },
      {
        definition: childrenDefinition,
        schema: childrenSchema,
        file: {
          origin: "core_operation_result",
          relative_path: "children.csv",
          delimiter: ",",
          operation_result: children,
        },
        provenance_refs: ["prov_children"],
        confidence_refs: ["conf_children"],
      },
    ],
    relations: [{
      relation_id: "children_parent",
      from_table_id: "children",
      from_fields: ["parent_id"],
      to_table_id: "parents",
      to_fields: ["parent_id"],
      cardinality: "many_to_one",
      missing_policy: "reject",
    }],
    trusted_root: trustedRoot,
    forbidden_roots: [forbiddenRoot],
    policy: {
      token_preservation_rules: [{
        // parent_id is a relation-role token field; the fixture declares the
        // identity-preserving rule that the token coverage gate requires.
        table_id: "children",
        source_field: "parent_id",
        output_field: "parent_id",
        token_kind: "relation",
      }],
      profile_relation_missing_policies: {},
    },
  };
  return { request, trustedRoot };
}

export function memoryOptions(
  telemetrySink: MultiTableValidationOptions["resourceBaseline"]["telemetrySink"],
): MultiTableValidationOptions {
  return {
    resourceBaseline: {
      policy: parityPolicy,
      configuredHeapBytes: 2_000_000,
      configuredTempBytes: 256 * 1024 * 1024,
      telemetrySink,
    },
  };
}

export function diskFactory(): MultiTableB3BackendOptions["factory"] {
  return {
    factoryId: "parity-tuple-index.v1",
    createIndex: async (options) => createTupleIndex({
      mode: "disk",
      owner: { taskId: options.owner.taskId, generation: options.owner.generation },
      directory: options.directory,
      quotaBytes: options.quotaBytes,
      batchSize: options.batchSize,
    }),
  };
}

export function diskOptions(
  request: MultiTableValidationRequest,
  telemetrySink: MultiTableValidationOptions["resourceBaseline"]["telemetrySink"],
): MultiTableValidationOptions {
  return {
    resourceBaseline: {
      policy: { ...parityPolicy, memoryThresholdBytes: 0 },
      configuredHeapBytes: 2_000_000,
      configuredTempBytes: 256 * 1024 * 1024,
      telemetrySink,
    },
    b3Backend: {
      owner: { taskId: request.task_id, buildId: request.build_id, generation: 0 },
      factory: diskFactory(),
      snapshotImmutable: true,
      parityProof: { digest: "ab".repeat(32), ref: "b3-parity/evidence/parity-1" },
      cleanup: { ownerId: "parity-owner", cleanup: async () => {} },
      quotaBytesPerIndex: 32 * 1024 * 1024,
    },
  };
}

/**
 * Parity digest: excludes path- and mode-bearing checks, documented in the
 * committed evidence file.
 */
export function parityChecksDigest(checks: readonly MultiTableValidationCheck[]): string {
  return canonicalDigest(
    checks.filter((item) =>
      item.check_id !== "resource_baseline" && item.check_id !== "trusted_root",
    ),
  );
}

export async function removeParityRoots(roots: readonly string[]): Promise<void> {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}

export { validateMultiTableCandidate };
