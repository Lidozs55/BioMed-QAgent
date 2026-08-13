import { describe, expect, test } from "vitest";

import {
  checkConfidenceParity,
  checkSpecValidatorParity,
  checkValidationProfileParity,
  scratchOutputRoot,
} from "./validation-parity.js";

describe("Phase 4 step 8 validation parity", () => {
  test("confidence detectors mirror test_dataset_confidence.py", () => {
    expect(checkConfidenceParity()).toEqual([]);
  });

  test("validation profile release gate mirrors test_dataset_profiles.py", () => {
    const issues = checkValidationProfileParity({
      outputRoot: scratchOutputRoot("validation-profile-vitest-"),
    });
    expect(issues).toEqual([]);
  });

  test("spec validator mirrors test_spec_validator.py", () => {
    expect(checkSpecValidatorParity()).toEqual([]);
  });
});
