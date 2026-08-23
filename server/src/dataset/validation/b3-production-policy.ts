/**
 * Production B3 resource policy for the trusted dynamic-family multitable
 * validation lane (C-T4/C-T11).
 *
 * This module owns the server-side production defaults that connect the
 * measured resource baseline to the production validator. The estimator
 * arithmetic is benchmarked by `server/tests/ct4-resource-baseline-bench.run.ts`
 * (run in the same commit as any policy change); the overhead constants below
 * are conservative bookkeeping bounds, not measured allocations. Values stay
 * injected at the validator boundary — this module is the production caller's
 * policy, not a global default inside the estimator.
 *
 * Memory/disk parity is declared through `PRODUCTION_B3_PARITY_PROOF`, which
 * references the committed evidence file `server/tests/fixtures/b3-memory-disk-parity-v1.json`
 * (recorded memory/disk checks digests over the C-T11 relation fixture). The
 * digest is the SHA-256 of the committed evidence bytes; the parity test
 * recomputes both the file digest and the live memory/disk digests.
 */
import { createTupleIndex } from "./disk-index.js";
import type {
  B3DiskTupleIndexFactory,
  B3ParityProof,
} from "./b3-backend-decision/index.js";
import type { ResourceBaselinePolicy } from "./resource-baseline.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const PRODUCTION_B3_POLICY_ID = "b3-production-multitable.v1" as const;

export const PRODUCTION_B3_RESOURCE_POLICY: ResourceBaselinePolicy = {
  policyId: PRODUCTION_B3_POLICY_ID,
  // First byte above the effective memory threshold selects disk or reject.
  memoryThresholdBytes: 256 * MIB,
  heapQuotaBytes: 512 * MIB,
  tempQuotaBytes: 8 * GIB,
  rowOverheadBytes: 24,
  keyEntryOverheadBytes: 72,
  tupleFieldOverheadBytes: 8,
  maxRowCharacters: 1 * MIB,
  maxFieldCharacters: 512 * 1024,
};

export const PRODUCTION_B3_CONFIGURED_HEAP_BYTES = 512 * MIB;
export const PRODUCTION_B3_CONFIGURED_TEMP_BYTES = 8 * GIB;

/** Per-index SQLite quota for the task-owned disk tuple indexes. */
export const PRODUCTION_B3_DISK_QUOTA_BYTES_PER_INDEX = 512 * MIB;
export const PRODUCTION_B3_DISK_BATCH_SIZE = 4096;

export const PRODUCTION_B3_PARITY_EVIDENCE_REF =
  "server/tests/fixtures/b3-memory-disk-parity-v1.json" as const;

export const PRODUCTION_B3_PARITY_PROOF: B3ParityProof = {
  digest: "324b8cf1f9f0f753c4fbd873f1a581f768166a25d8bc0ee5553b25a57311b610",
  ref: PRODUCTION_B3_PARITY_EVIDENCE_REF,
};

/**
 * Production factory for the real SQLite-backed TupleIndex. The owner
 * generation comes from the Core-owned transform receipt; the validator
 * rechecks each created index binding after creation.
 */
export function createProductionB3DiskFactory(): B3DiskTupleIndexFactory {
  return {
    factoryId: "b3-sqlite-tuple-index.v1",
    createIndex: async (options) => createTupleIndex({
      mode: "disk",
      owner: { taskId: options.owner.taskId, generation: options.owner.generation },
      directory: options.directory,
      quotaBytes: options.quotaBytes,
      batchSize: options.batchSize,
    }),
  };
}
