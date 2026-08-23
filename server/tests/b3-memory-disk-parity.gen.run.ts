/**
 * Generates server/tests/fixtures/b3-memory-disk-parity-v1.json from the
 * live memory/disk runs and prints the SHA-256 to paste into
 * PRODUCTION_B3_PARITY_PROOF.digest:
 *   pnpm --filter @biomed/server exec tsx tests/b3-memory-disk-parity.gen.run.ts
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  diskOptions,
  memoryOptions,
  parityChecksDigest,
  parityRequest,
  removeParityRoots,
  validateMultiTableCandidate,
} from "./b3-memory-disk-parity.fixture.js";

const { request, trustedRoot } = await parityRequest();
try {
  const memory = await validateMultiTableCandidate(
    request,
    new AbortController().signal,
    memoryOptions(() => undefined),
  );
  const disk = await validateMultiTableCandidate(
    request,
    new AbortController().signal,
    diskOptions(request, () => undefined),
  );
  const memoryChecksDigest = parityChecksDigest(memory.checks);
  const diskChecksDigest = parityChecksDigest(disk.checks);
  const evidence = {
    schema_version: "b3-memory-disk-parity-evidence.v1",
    description:
      "Recorded memory/disk B3 checks digest parity on the C-T11 relation fixture " +
      "(parents/children with one many_to_one FK, one missing referenced key, one " +
      "duplicated FK value). trusted_root and resource_baseline checks are excluded: " +
      "trusted_root detail embeds an absolute host path and resource_baseline carries " +
      "the selected validator mode.",
    fixture: {
      tables: ["parents", "children"],
      relations: ["children_parent"],
      rows: { parents: 2, children: 3 },
      memoryChecksCount: memory.checks.length,
      diskChecksCount: disk.checks.length,
    },
    memoryChecksDigest,
    diskChecksDigest,
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidencePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "b3-memory-disk-parity-v1.json",
  );
  await writeFile(evidencePath, json, "utf8");
  console.log(`wrote ${evidencePath}`);
  console.log(createHash("sha256").update(json, "utf8").digest("hex"));
} finally {
  await removeParityRoots([trustedRoot]);
}
