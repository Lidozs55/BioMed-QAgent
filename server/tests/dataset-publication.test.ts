import { describe, expect, test } from "vitest";

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  checkInvariantsParity,
  checkManifestParity,
  checkPublisherParity,
  scratchOutputRoot,
} from "./publication-parity.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("Phase 4 step 9 publication parity", () => {
  test("release invariants mirror test_dataset_invariants.py", async () => {
    expect(
      await checkInvariantsParity({ outputRoot: scratchOutputRoot("publication-invariants-vitest-") }),
    ).toEqual([]);
  });

  test("manifest assembly mirrors test_dataset_manifest.py", async () => {
    expect(
      await checkManifestParity({
        fixturesRoot: join(repoRoot, "backend", "tests", "fixtures"),
        outputRoot: scratchOutputRoot("publication-manifest-vitest-"),
      }),
    ).toEqual([]);
  });

  test("atomic promotion mirrors the publish path of test_dataset_expression_runner.py", async () => {
    expect(
      await checkPublisherParity({ outputRoot: scratchOutputRoot("publication-publisher-vitest-") }),
    ).toEqual([]);
  });
});