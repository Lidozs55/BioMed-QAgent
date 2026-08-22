/**
 * C-T4 synthetic large-input estimator benchmark.
 *
 * This harness only exercises constant-space arithmetic over synthetic row/key
 * estimates. It does not allocate rows or keys and is not run by Vitest because
 * of the `.run.ts` suffix.
 *
 * Run in the same commit as any proposed policy change:
 *   pnpm --filter @biomed/server exec tsx tests/ct4-resource-baseline-bench.run.ts
 *
 * The output is benchmark evidence, not a measured production threshold. Keep
 * the policy explicitly injected; do not copy these synthetic values into a
 * production default without a representative same-commit benchmark.
 */

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  decideValidatorResources,
  type ResourceBaselinePolicy,
} from "../src/dataset/validation/resource-baseline.js";

const policy: ResourceBaselinePolicy = {
  policyId: "ct4-synthetic-benchmark-only",
  memoryThresholdBytes: 256 * 1024 * 1024,
  heapQuotaBytes: 512 * 1024 * 1024,
  tempQuotaBytes: 8 * 1024 * 1024 * 1024,
  rowOverheadBytes: 24,
  keyEntryOverheadBytes: 72,
  tupleFieldOverheadBytes: 8,
  maxRowCharacters: 1_048_576,
  maxFieldCharacters: 524_288,
};

const input = {
  rowEstimate: 50_000_000,
  keyEstimates: [
    {
      keyId: "primary",
      entryEstimate: 50_000_000,
      tupleWidthEstimateBytes: 48,
      tupleFieldCount: 2,
    },
    {
      keyId: "foreign",
      entryEstimate: 50_000_000,
      tupleWidthEstimateBytes: 32,
      tupleFieldCount: 1,
    },
  ],
  configuredHeapBytes: 512 * 1024 * 1024,
  configuredTempBytes: 8 * 1024 * 1024 * 1024,
  diskIndexAvailable: true,
  cancelCapable: true,
} as const;

const iterations = 100_000;
const startedAt = performance.now();
let decision = decideValidatorResources(input, policy);
for (let index = 1; index < iterations; index += 1) {
  decision = decideValidatorResources(input, policy);
}
const durationMs = performance.now() - startedAt;
const sameCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

console.log(JSON.stringify({
  benchmark: "ct4-resource-baseline-synthetic-v1",
  disclaimer: "synthetic estimator evidence only; not a measured production threshold",
  sameCommit,
  iterations,
  durationMs,
  operationsPerSecond: iterations / (durationMs / 1_000),
  input,
  policy,
  decision,
  processMemoryUsage: process.memoryUsage(),
}, null, 2));
