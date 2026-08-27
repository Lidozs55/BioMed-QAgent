/**
 * DatasetExecutionSpec contract (Python ``DatasetExecutionSpec`` /
 * ``SourceBinding`` / ``SourceBindingAcquisition``). The wire shapes come
 * from ``@biomed/contracts``; these parsers enforce the path-safe identifier
 * and acquisition-mode invariants the Python spec validator relies on.
 */

import type {
  DatasetExecutionSourceAcquisition,
  DatasetExecutionSourceBinding,
  DatasetExecutionSpec,
} from "@biomed/contracts";
import {
  assertExactKeys,
  assertJsonRecord,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertOptionalNonEmptyString,
  assertOptionalString,
  assertRecord,
  assertSafeId,
  assertString,
  assertStringArray,
  assertStringRecord,
  parseSchemaVersion,
} from "./primitives.js";

export type {
  DatasetExecutionSourceAcquisition as SourceBindingAcquisition,
  DatasetExecutionSourceBinding as SourceBinding,
  DatasetExecutionSpec,
} from "@biomed/contracts";

const SOURCE_BINDING_ACQUISITION_KEYS = [
  "schema_version",
  "mode",
  "provider_id",
  "recipe_id",
  "recipe_version",
] as const;

export function parseSourceBindingAcquisition(
  value: unknown,
): DatasetExecutionSourceAcquisition {
  const record = assertRecord(value, "SourceBindingAcquisition");
  assertExactKeys(record, SOURCE_BINDING_ACQUISITION_KEYS, "SourceBindingAcquisition");
  const mode = assertString(record.mode, "SourceBindingAcquisition.mode");
  if (mode !== "builtin" && mode !== "workflow_recipe") {
    throw new TypeError(
      "SourceBindingAcquisition.mode must be one of builtin, workflow_recipe",
    );
  }
  const providerId = assertOptionalNonEmptyString(
    record.provider_id,
    "SourceBindingAcquisition.provider_id",
  );
  const recipeId = assertOptionalNonEmptyString(
    record.recipe_id,
    "SourceBindingAcquisition.recipe_id",
  );
  const recipeVersion = (() => {
    if (record.recipe_version === undefined || record.recipe_version === null) {
      return null;
    }
    const version = assertNonNegativeInt(
      record.recipe_version,
      "SourceBindingAcquisition.recipe_version",
    );
    if (version < 1) {
      throw new TypeError("SourceBindingAcquisition.recipe_version must be >= 1");
    }
    return version;
  })();
  if (mode === "builtin" && providerId === null) {
    throw new TypeError("builtin acquisition requires provider_id");
  }
  if (mode === "workflow_recipe") {
    if (recipeId === null) {
      throw new TypeError("workflow_recipe acquisition requires recipe_id");
    }
    if (recipeVersion === null) {
      throw new TypeError("workflow_recipe acquisition requires recipe_version");
    }
  }
  return {
    schema_version: parseSchemaVersion(record),
    mode,
    provider_id: providerId,
    recipe_id: recipeId,
    recipe_version: recipeVersion,
  };
}

const SOURCE_BINDING_KEYS = [
  "schema_version",
  "binding_id",
  "source",
  "acquisition",
  "adapter_id",
  "accession",
  "parameters",
] as const;

export function parseSourceBinding(value: unknown): DatasetExecutionSourceBinding {
  const record = assertRecord(value, "SourceBinding");
  assertExactKeys(record, SOURCE_BINDING_KEYS, "SourceBinding");
  return {
    schema_version: parseSchemaVersion(record),
    binding_id: assertSafeId(record.binding_id, "SourceBinding.binding_id"),
    source: assertNonEmptyString(record.source, "SourceBinding.source"),
    acquisition: parseSourceBindingAcquisition(record.acquisition),
    adapter_id: assertNonEmptyString(record.adapter_id, "SourceBinding.adapter_id"),
    accession: assertOptionalString(record.accession, "SourceBinding.accession"),
    parameters: record.parameters === undefined
      ? {}
      : assertJsonRecord(record.parameters, "SourceBinding.parameters"),
  };
}

const DATASET_BUILD_SPEC_KEYS = [
  "schema_version",
  "requirement_id",
  "objective",
  "dataset_family",
  "row_granularity",
  "entities",
  "cohort_filters",
  "required_fields",
  "schema_ref",
  "source_bindings",
  "normalization_profile_ref",
  "merge_strategy",
  "validation_profile_ref",
  "output_format",
  "target_entity_level",
] as const;

export function parseDatasetExecutionSpec(value: unknown): DatasetExecutionSpec {
  const record = assertRecord(value, "DatasetExecutionSpec");
  assertExactKeys(record, DATASET_BUILD_SPEC_KEYS, "DatasetExecutionSpec");
  const sourceBindings = (() => {
    if (!Array.isArray(record.source_bindings) || record.source_bindings.length === 0) {
      throw new TypeError(
        "DatasetExecutionSpec.source_bindings must be a non-empty array",
      );
    }
    return record.source_bindings.map((binding) => parseSourceBinding(binding));
  })();
  const targetEntityLevel = (() => {
    if (record.target_entity_level === undefined || record.target_entity_level === null) {
      return null;
    }
    return assertNonEmptyString(
      record.target_entity_level,
      "DatasetExecutionSpec.target_entity_level",
    );
  })();
  return {
    schema_version: parseSchemaVersion(record),
    requirement_id: assertSafeId(record.requirement_id, "DatasetExecutionSpec.requirement_id"),
    objective: assertNonEmptyString(record.objective, "DatasetExecutionSpec.objective"),
    dataset_family: assertNonEmptyString(
      record.dataset_family,
      "DatasetExecutionSpec.dataset_family",
    ),
    row_granularity: assertNonEmptyString(
      record.row_granularity,
      "DatasetExecutionSpec.row_granularity",
    ),
    entities: record.entities === undefined
      ? {}
      : assertStringRecord(record.entities, "DatasetExecutionSpec.entities"),
    cohort_filters: record.cohort_filters === undefined
      ? {}
      : assertStringRecord(record.cohort_filters, "DatasetExecutionSpec.cohort_filters"),
    required_fields: record.required_fields === undefined
      ? []
      : assertStringArray(record.required_fields, "DatasetExecutionSpec.required_fields"),
    schema_ref: assertNonEmptyString(record.schema_ref, "DatasetExecutionSpec.schema_ref"),
    source_bindings: sourceBindings,
    normalization_profile_ref: assertOptionalString(
      record.normalization_profile_ref,
      "DatasetExecutionSpec.normalization_profile_ref",
    ),
    merge_strategy: record.merge_strategy === undefined
      ? "append_by_canonical_row"
      : assertNonEmptyString(record.merge_strategy, "DatasetExecutionSpec.merge_strategy"),
    validation_profile_ref: assertNonEmptyString(
      record.validation_profile_ref,
      "DatasetExecutionSpec.validation_profile_ref",
    ),
    output_format: record.output_format === undefined
      ? "csv"
      : assertNonEmptyString(record.output_format, "DatasetExecutionSpec.output_format"),
    target_entity_level: targetEntityLevel,
  };
}

