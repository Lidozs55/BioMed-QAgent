import { describe, expect, test } from "vitest";

import { createDefaultSchemaRegistry } from "../src/dataset/schema/registry.js";
import { VALIDATION_PROFILE_REFS } from "../src/dataset/validation/profile.js";
import { SpecValidator } from "../src/dataset/validation/spec_validator.js";
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

  test("malformed spec missing required_fields/source_bindings yields a validation result, not a throw", () => {
    // Regression: an LLM may hand the build tool a spec that references a
    // registered schema while omitting required_fields / source_bindings.
    // The validator must reject it with readable reasons instead of crashing
    // (which surfaced to the agent as the opaque "Dataset build tool failed").
    const validator = new SpecValidator(createDefaultSchemaRegistry(), VALIDATION_PROFILE_REFS);
    const malformed = {
      schema_ref: "gene_expression.long.v1",
      dataset_family: "gene_expression",
    };
    expect(() => validator.validate(malformed as never)).not.toThrow();
    const result = validator.validate(malformed as never);
    expect(result.valid).toBe(false);
    expect(result.reason_codes.length).toBeGreaterThan(0);
  });
});
