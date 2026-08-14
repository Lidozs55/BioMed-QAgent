import { describe, expect, test } from "vitest";

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  checkCompatGateContractParity,
  checkCompatGateFixtureParity,
  scratchOutputRoot,
} from "./compat-gate-parity.js";
import { checkExpressionCompatibility } from "../src/dataset/compat/index.js";
import { parseDatasetBuildSpec } from "../src/dataset/contracts/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("Phase 4 step 6 compat gate parity", () => {
  test("gate rules mirror test_dataset_compat_gate.py contract cases", async () => {
    expect(await checkCompatGateContractParity()).toEqual([]);
  });

  test("fixture-driven gate matrix mirrors the Python suite", async () => {
    const issues = await checkCompatGateFixtureParity({
      fixturesRoot: join(repoRoot, "backend", "tests", "fixtures"),
      outputRoot: scratchOutputRoot("compat-vitest-"),
    });
    expect(issues).toEqual([]);
  });

  test("no sources reports no_sources", () => {
    const spec = parseDatasetBuildSpec({
      build_id: "build_test",
      objective: "compare expression",
      dataset_family: "gene_expression",
      row_granularity: "gene_sample_measurement",
      schema_ref: "gene_expression.long.v1",
      source_bindings: [
        {
          binding_id: "binding_gdc",
          source: "gdc",
          acquisition: { mode: "builtin", provider_id: "gdc.files.v1" },
          adapter_id: "gdc.expression.v1",
        },
      ],
      validation_profile_ref: "gene_expression.release.v1",
    });
    expect(checkExpressionCompatibility({ spec, results: [] })).toEqual({
      compatible: false,
      reasons: ["no_sources"],
    });
  });
});