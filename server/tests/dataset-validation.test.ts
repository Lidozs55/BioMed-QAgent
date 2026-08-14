import { describe, expect, test } from "vitest";

import {
  checkConfidenceParity,
  checkSpecValidatorParity,
  checkValidationProfileParity,
  scratchOutputRoot,
} from "./validation-parity.js";

describe("Phase 4 step 8 validation parity", () => {
  test("confidence detectors mirror test_dataset_confidence.py", async () => {
    expect(await checkConfidenceParity()).toEqual([]);
  });

  test("validation profile release gate mirrors test_dataset_profiles.py", async () => {
    const issues = await checkValidationProfileParity({
      outputRoot: scratchOutputRoot("validation-profile-vitest-"),
    });
    expect(issues).toEqual([]);
  });

  test("spec validator mirrors test_spec_validator.py", async () => {
    expect(await checkSpecValidatorParity()).toEqual([]);
  });
});
