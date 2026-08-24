import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  PRODUCTION_B3_PARITY_PROOF,
} from "../src/dataset/validation/b3-production-policy.js";
import {
  diskOptions,
  memoryOptions,
  parityChecksDigest,
  parityRequest,
  removeParityRoots,
  validateMultiTableCandidate,
} from "./b3-memory-disk-parity.fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await removeParityRoots(roots.splice(0));
});

describe("C-T11 B3 memory/disk parity on PK + FK/cardinality index reuse", () => {
  it("produces identical checks, ordering and digest in memory and disk modes", async () => {
    const { request, trustedRoot } = await parityRequest();
    roots.push(trustedRoot);
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

    expect(memory.passed).toBe(false);
    expect(disk.passed).toBe(memory.passed);
    expect(disk.checks.filter((item) => item.check_id !== "resource_baseline")).toEqual(
      memory.checks.filter((item) => item.check_id !== "resource_baseline"),
    );
    expect(parityChecksDigest(disk.checks)).toBe(parityChecksDigest(memory.checks));
    expect(disk.checks.find((item) => item.check_id === "foreign_key")).toEqual(
      expect.objectContaining({ scope: "children_parent", passed: false, detail: "missing=1; policy=reject" }),
    );
    expect(disk.checks.find((item) => item.check_id === "cardinality")).toEqual(
      expect.objectContaining({
        scope: "children_parent",
        passed: true,
        detail: "cardinality=many_to_one; from_duplicate_keys=1; to_duplicate_keys=0",
      }),
    );
    expect(disk.checks.find((item) => item.check_id === "primary_key_uniqueness")).toEqual(
      expect.objectContaining({ passed: true, detail: "0 duplicate primary key value(s); null_or_blank=0" }),
    );
  });

  it("matches the committed parity evidence and the production parity proof digest", async () => {
    const evidencePath = fileURLToPath(
      new URL("./fixtures/b3-memory-disk-parity-v1.json", import.meta.url),
    );
    const evidenceBytes = await readFile(evidencePath);
    const evidence = JSON.parse(evidenceBytes.toString("utf8")) as {
      schema_version: string;
      memoryChecksDigest: string;
      diskChecksDigest: string;
    };

    expect(evidence.schema_version).toBe("b3-memory-disk-parity-evidence.v1");
    expect(createHash("sha256").update(evidenceBytes).digest("hex"))
      .toBe(PRODUCTION_B3_PARITY_PROOF.digest);
    expect(PRODUCTION_B3_PARITY_PROOF.ref).toBe(
      "server/tests/fixtures/b3-memory-disk-parity-v1.json",
    );

    const { request, trustedRoot } = await parityRequest();
    roots.push(trustedRoot);
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
    expect(parityChecksDigest(memory.checks)).toBe(evidence.memoryChecksDigest);
    expect(parityChecksDigest(disk.checks)).toBe(evidence.diskChecksDigest);
    expect(evidence.memoryChecksDigest).toBe(evidence.diskChecksDigest);
  });
});
