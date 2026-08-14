import { describe, expect, test } from "vitest";

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  checkCanonicalizerContractParity,
  checkCanonicalizerFixtureParity,
  scratchOutputRoot,
} from "./canonicalizer-parity.js";
import { MeasurementIdentity } from "../src/dataset/canonicalizer/index.js";
import { buildProbeExpressionSchema } from "../src/dataset/schema/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("Phase 4 step 5 canonicalizer parity", () => {
  test("namespace/identity/map invariants mirror test_dataset_canonicalizer.py", async () => {
    expect(await checkCanonicalizerContractParity()).toEqual([]);
  });

  test("GDC/Xena canonicalization fixture parity mirrors the Python suite", async () => {
    const issues = await checkCanonicalizerFixtureParity({
      fixturesRoot: join(repoRoot, "tests", "fixtures"),
      outputRoot: scratchOutputRoot("canonicalizer-vitest-"),
    });
    expect(issues).toEqual([]);
  });

  test("MeasurementIdentity round-trips and sorts stably", () => {
    const identity = new MeasurementIdentity("normalized_expression", "log2", "log2_expression");
    expect(identity.serialize()).toEqual(["normalized_expression", "log2", "log2_expression"]);
    const restored = MeasurementIdentity.deserialize(identity.serialize());
    expect(restored.compareTo(identity)).toBe(0);
  });

  test("probe schema declares probe_id / platform_id / value", () => {
    const schema = buildProbeExpressionSchema();
    const columns = schema.fields.map((field) => field.name);
    expect(columns).toContain("probe_id");
    expect(columns).toContain("platform_id");
    expect(columns).toContain("value");
  });
});