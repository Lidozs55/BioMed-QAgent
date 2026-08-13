import { describe, expect, test } from "vitest";

import { checkRuntimeParity, scratchOutputRoot } from "./runtime-parity.js";

describe("Phase 4 step 10 runtime parity", () => {
  test("executor plan/reuse/cancel/recovery mirror test_dataset_runtime.py", async () => {
    expect(await checkRuntimeParity({ outputRoot: scratchOutputRoot("runtime-vitest-") })).toEqual([]);
  });
});