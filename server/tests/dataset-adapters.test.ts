import { describe, expect, test } from "vitest";

import { fileURLToPath } from "node:url";
import { parseDownloadAttempt } from "../src/dataset/contracts/index.js";
import { join } from "node:path";

import {
  checkAdapterContractParity,
  checkAdapterFixtureParity,
  scratchOutputRoot,
} from "./adapters-parity.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("Phase 4 step 4 adapters parity", () => {
  test("adapter contract invariants mirror the Python contract tests", async () => {
    expect(await checkAdapterContractParity()).toEqual([]);
  });

  test("GDC/Xena adapter fixture parity mirrors test_dataset_adapters.py", async () => {
    const issues = await checkAdapterFixtureParity({
      fixturesRoot: join(repoRoot, "tests", "fixtures"),
      outputRoot: scratchOutputRoot("adapter-vitest-"),
    });
    expect(issues).toEqual([]);
  });

  test("download attempt round-trips with schema_version 1.0", () => {
    const attempt = parseDownloadAttempt({
      attempt_id: "attempt_1",
      source_id: "src_geo",
      url: "https://example.test/counts.gz",
      status: "succeeded",
      bytes_received: 42,
      started_at: "2026-07-12T00:00:00Z",
      finished_at: "2026-07-12T00:00:01Z",
    });
    expect(attempt.schema_version).toBe("1.0");
    expect(attempt.status).toBe("succeeded");
  });
});