import { describe, expect, test } from "vitest";

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  checkIntegratorParity,
  scratchOutputRoot,
} from "./integrator-parity.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("Phase 4 step 7 integrator parity", () => {
  test("fixture-driven integrator matrix mirrors test_dataset_integrator.py", () => {
    const issues = checkIntegratorParity({
      fixturesRoot: join(repoRoot, "backend", "tests", "fixtures"),
      outputRoot: scratchOutputRoot("integrator-vitest-"),
    });
    expect(issues).toEqual([]);
  });
});
