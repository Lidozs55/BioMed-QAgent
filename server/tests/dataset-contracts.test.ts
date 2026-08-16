import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import type { DatasetBuildSpec, DatasetSchema } from "../src/dataset/contracts/index.js";
import {
  parseBuildResult,
  parseDatasetBuildSpec,
  parseDatasetManifest,
  parseDatasetPublication,
  parseDatasetSchema,
  parseFieldMapping,
  parseFileAsset,
  parseSourceBindingAcquisition,
  parseValidationResult,
} from "../src/dataset/contracts/index.js";
import { checkContractParity } from "./contract-parity.js";
import type { GoldenFixture } from "./contract-parity.js";
import { datasetBuildSpec as spec } from "./dataset-bridge-fixture.js";

const GOLDEN_OUTCOMES = ["succeeded", "partial_success", "no_data", "spec_rejected"];

function loadGoldenFixture(outcome: string): GoldenFixture {
  const raw = JSON.parse(
    readFileSync(
      new URL(`../../tests/migration/golden/${outcome}/fixture.json`, import.meta.url),
      "utf8",
    ),
  ) as GoldenFixture;
  return raw;
}

describe("Phase 4 step 1 contract parity (Python V2 fixtures)", () => {
  test.each(GOLDEN_OUTCOMES)("%s fixture parses and round-trips", (outcome) => {
    const issues = checkContractParity(loadGoldenFixture(outcome));
    expect(issues).toEqual([]);
  });

  test("schema artifact parses as the registered DatasetSchema", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../tests/migration/golden/succeeded/artifacts/schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;
    const parsed = parseDatasetSchema(schema);
    expect(parsed.schema_id).toBe("gene_expression.long.v1");
    expect(parsed.primary_key).toEqual([
      "dataset_id",
      "sample_id",
      "gene_id",
      "measurement_type",
    ]);
    expect(parsed.fields).toHaveLength(22);
    expect(parsed.fields.every((field) => field.schema_version === "1.0")).toBe(true);
  });
});

describe("contract invariants (mirror Pydantic model_validator)", () => {
  const validSchema: DatasetSchema = {
    schema_id: "gene_expression.long.v1",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    primary_key: ["gene_id"],
    fields: [
      {
        name: "gene_id",
        data_type: "string",
        semantic_role: "entity_identifier",
        required: true,
        unit_policy: null,
        ontology: null,
        description: "",
        derivation_policy: null,
      },
    ],
  };

  test("DatasetSchema rejects duplicate field names", () => {
    const duplicate = {
      ...validSchema,
      fields: [
        { ...validSchema.fields[0] },
        { ...validSchema.fields[0], description: "second" },
      ],
    };
    expect(() => parseDatasetSchema(duplicate)).toThrow(/unique/);
  });

  test("DatasetSchema rejects primary_key not declared in fields", () => {
    expect(() =>
      parseDatasetSchema({ ...validSchema, primary_key: ["missing"] }),
    ).toThrow(/missing/);
  });

  test("DatasetSchema defaults schema_version to 1.0", () => {
    expect(parseDatasetSchema(validSchema).schema_version).toBe("1.0");
  });

  test("ValidationResult rejects passed with failed checks", () => {
    expect(() =>
      parseValidationResult({
        manifest_digest: "digest",
        profile_ref: "gene_expression.release.v1",
        status: "passed",
        checked_count: 2,
        failed_count: 1,
      }),
    ).toThrow(/passed requires zero failed checks/);
  });

  test("ValidationResult rejects failed with zero failures", () => {
    expect(() =>
      parseValidationResult({
        manifest_digest: "digest",
        profile_ref: "gene_expression.release.v1",
        status: "failed",
        checked_count: 2,
        failed_count: 0,
      }),
    ).toThrow(/failed requires at least one failed check/);
  });

  test("ValidationResult rejects failed_count above checked_count", () => {
    expect(() =>
      parseValidationResult({
        manifest_digest: "digest",
        profile_ref: "gene_expression.release.v1",
        status: "failed",
        checked_count: 1,
        failed_count: 2,
      }),
    ).toThrow(/must not exceed/);
  });

  test("DatasetManifest rejects more than one primary artifact", () => {
    const artifact = {
      artifact_id: "artifact_1",
      role: "primary_dataset",
      relative_path: "primary.csv",
      media_type: "text/csv",
      size_bytes: 10,
      sha256: "abc",
    };
    expect(() =>
      parseDatasetManifest({
        manifest_id: "manifest_1",
        task_id: "task_1",
        build_id: "build_1",
        dataset_family: "gene_expression",
        row_granularity: "gene_sample_measurement",
        schema_ref: "gene_expression.long.v1",
        row_count: 1,
        sha256: "abc",
        artifacts: [artifact, { ...artifact, artifact_id: "artifact_2" }],
      }),
    ).toThrow(/at most one primary_dataset/);
  });

  test("DatasetPublication rejects self-supersede", () => {
    expect(() =>
      parseDatasetPublication({
        publication_id: "pub_1",
        manifest_ref: "manifest.json",
        validation_result_ref: "validation.json",
        published_at: "2026-08-11T00:00:00Z",
        supersedes_publication_id: "pub_1",
      }),
    ).toThrow(/cannot supersede itself/);
  });

  test("DatasetPublication carries the manifest file hash (P7 receipt)", () => {
    const parsed = parseDatasetPublication({
      publication_id: "pub_1",
      manifest_ref: "manifest.json",
      manifest_sha256: "a".repeat(64),
      validation_result_ref: "validation.json",
      published_at: "2026-08-11T00:00:00Z",
      supersedes_publication_id: null,
    });
    expect(parsed.manifest_sha256).toBe("a".repeat(64));
    // The receipt is required: a publication without it must not parse.
    const missing = {
      publication_id: "pub_1",
      manifest_ref: "manifest.json",
      validation_result_ref: "validation.json",
      published_at: "2026-08-11T00:00:00Z",
      supersedes_publication_id: null,
    };
    expect(() => parseDatasetPublication(missing)).toThrow(/manifest_sha256/);
  });

  test("FieldMapping keeps string-similarity mappings proposed", () => {
    expect(() =>
      parseFieldMapping({
        mapping_id: "map_1",
        source_schema_ref: "src.v1",
        target_schema_ref: "gene_expression.long.v1",
        source_field: "a",
        target_field: "b",
        mapping_method: "string_similarity",
        confidence_level: "medium",
        evidence: "similar",
        review_status: "accepted",
      }),
    ).toThrow(/must remain proposed/);
  });

  test("SourceBindingAcquisition rejects an empty provider_id", () => {
    expect(() =>
      parseSourceBindingAcquisition({
        mode: "builtin",
        provider_id: "",
        recipe_id: null,
        recipe_version: null,
      }),
    ).toThrow(/must be a non-empty string/);
  });

  test("SourceBindingAcquisition requires provider_id for builtin", () => {
    expect(() =>
      parseSourceBindingAcquisition({
        mode: "builtin",
        provider_id: null,
        recipe_id: null,
        recipe_version: null,
      }),
    ).toThrow(/builtin acquisition requires provider_id/);
  });

  test("SourceBindingAcquisition requires recipe_version for workflow_recipe", () => {
    expect(() =>
      parseSourceBindingAcquisition({
        mode: "workflow_recipe",
        provider_id: null,
        recipe_id: "recipe_1",
        recipe_version: null,
      }),
    ).toThrow(/requires recipe_version/);
  });

  test("BuildResult rejects succeeded without publication", () => {
    expect(() =>
      parseBuildResult({
        status: "succeeded",
        valid_row_count: 4,
        successful_sources: ["binding_1"],
        publication_id: null,
      }),
    ).toThrow(/succeeded build requires publication_id/);
  });

  test("BuildResult rejects no_data with valid rows", () => {
    expect(() =>
      parseBuildResult({
        status: "no_data",
        valid_row_count: 4,
        reason_codes: ["no_primary_data"],
      }),
    ).toThrow(/no_data build must have zero valid rows/);
  });

  test("BuildResult rejects spec_rejected without reason codes", () => {
    expect(() =>
      parseBuildResult({
        status: "spec_rejected",
        valid_row_count: 0,
        reason_codes: [],
      }),
    ).toThrow(/spec_rejected build requires reason_codes/);
  });

  test("BuildResult rejects publication_id on no_data", () => {
    expect(() =>
      parseBuildResult({
        status: "no_data",
        valid_row_count: 0,
        publication_id: "pub_1",
        reason_codes: ["no_primary_data"],
      }),
    ).toThrow(/only valid for succeeded or partial_success/);
  });

  test("FileAsset rejects an asset_id not derived from the sha256", () => {
    expect(() =>
      parseFileAsset({
        asset_id: "asset_wrong",
        kind: "source",
        relative_path: "source_assets/raw.tsv",
        sha256: "e0a607a1ca084789778113f316ef2afd93019984ddb4645f02ebf312275f58c7",
        size_bytes: 10,
        media_type: "text/tab-separated-values",
      }),
    ).toThrow(/asset_id must be derived/);
  });

  test("FileAsset rejects a relative_path that escapes its root", () => {
    expect(() =>
      parseFileAsset({
        asset_id: "asset_e0a607a1ca084789778113f316ef2afd93019984ddb4645f02ebf312275f58c7",
        kind: "source",
        relative_path: "source_assets/../escape.tsv",
        sha256: "e0a607a1ca084789778113f316ef2afd93019984ddb4645f02ebf312275f58c7",
        size_bytes: 10,
        media_type: "text/tab-separated-values",
      }),
    ).toThrow(/must not be absolute or escape/);
  });

  test("DatasetBuildSpec rejects unknown fields (extra=forbid)", () => {
    expect(() => parseDatasetBuildSpec({ ...spec, smuggled_threshold: 1 })).toThrow(
      /unknown fields/,
    );
  });

  test("DatasetBuildSpec rejects a path-like binding_id", () => {
    expect(() =>
      parseDatasetBuildSpec({
        ...spec,
        source_bindings: [
          { ...spec.source_bindings[0], binding_id: "../escape" },
        ],
      }),
    ).toThrow(/safe path identifier/);
  });

  test("DatasetBuildSpec normalizes missing schema_version", () => {
    const withoutVersion: DatasetBuildSpec = { ...spec };
    delete withoutVersion.schema_version;
    expect(parseDatasetBuildSpec(withoutVersion).schema_version).toBe("1.0");
  });
});
