import { describe, expect, test } from "vitest";

import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import { createDefaultSchemaRegistry } from "../src/dataset/schema/registry.js";
import { VALIDATION_PROFILE_REFS } from "../src/dataset/validation/profile.js";
import { SpecValidator } from "../src/dataset/validation/spec_validator.js";
import {
  checkConfidenceParity,
  checkRowBounds,
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

  test("row/field/column length bounds surface as a failing check, not a crash", async () => {
    expect(await checkRowBounds()).toEqual([]);
  }, 60_000);

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

  test("family policy rejects mismatched granularity, merge strategy, and source adapter", () => {
    const familyRegistry = createDefaultDatasetFamilyRegistry();
    const validator = new SpecValidator(
      familyRegistry.schemaRegistry(),
      familyRegistry.validationProfileRefs(),
      familyRegistry,
    );
    const result = validator.validate({
      schema_ref: "gene_expression.long.v1",
      dataset_family: "gene_expression",
      row_granularity: "variant_assertion",
      required_fields: [],
      normalization_profile_ref: "variant.normalization.v1",
      validation_profile_ref: "gene_expression.release.v1",
      merge_strategy: "relational_assembly",
      output_format: "parquet",
      target_entity_level: "variant",
      source_bindings: [{
        binding_id: "bad",
        source: "geo",
        adapter_id: "xena.matrix.v1",
        parameters: {},
      }],
    } as never);

    expect(result.valid).toBe(false);
    expect(result.reason_codes).toEqual(expect.arrayContaining([
      "granularity_schema_mismatch",
      "normalization_profile_family_mismatch",
      "merge_strategy_not_supported",
      "output_format_not_supported",
      "entity_level_schema_mismatch",
      "adapter_source_mismatch",
    ]));
  });

  test("family policy rejects source/schema and profile/schema combinations", () => {
    const familyRegistry = createDefaultDatasetFamilyRegistry();
    const validator = new SpecValidator(
      familyRegistry.schemaRegistry(),
      familyRegistry.validationProfileRefs(),
      familyRegistry,
    );
    const result = validator.validate({
      schema_ref: "gene_expression.probe_long.v1",
      dataset_family: "gene_expression",
      row_granularity: "probe_sample_measurement",
      required_fields: [],
      normalization_profile_ref: null,
      validation_profile_ref: "gene_expression.release.v1",
      merge_strategy: "append_by_canonical_row",
      output_format: "csv",
      target_entity_level: "probe",
      source_bindings: [{
        binding_id: "gdc_probe",
        source: "gdc",
        adapter_id: "gdc.expression.v1",
        parameters: {},
      }],
    } as never);

    expect(result.valid).toBe(false);
    expect(result.reason_codes).toEqual(expect.arrayContaining([
      "profile_schema_mismatch",
      "source_schema_mismatch",
    ]));
    expect(result.reason_codes).not.toContain("normalization_profile_unavailable");
  });

  test("rejection reasons enumerate registered schemas and allowed validation profiles", () => {
    // Regression (e2e gold2): the agent looped on "schema None is not
    // registered; validation profile None is not on the server allowlist"
    // because the validator never revealed the valid schema_ref /
    // validation_profile_ref values, so it could not self-correct. The
    // reasons must list them.
    const validator = new SpecValidator(createDefaultSchemaRegistry(), VALIDATION_PROFILE_REFS);
    const result = validator.validate({
      schema_ref: null,
      validation_profile_ref: null,
    } as never);
    expect(result.valid).toBe(false);
    expect(result.reason_codes).toContain("unknown_schema");
    expect(result.reason_codes).toContain("profile_not_allowed");
    const joined = result.reasons.join("\n");
    expect(joined).toContain("gene_expression.long.v1");
    expect(joined).toContain("gene_expression.probe_long.v1");
    expect(joined).toContain("gene_expression.release.v1");
    expect(joined).toContain("gene_expression.probe_release.v1");
  });
});
