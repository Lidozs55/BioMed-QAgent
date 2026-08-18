import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import type { DatasetBuildSpec, DatasetSchema } from "../src/dataset/contracts/index.js";
import {
  parseBuildResult,
  parseDatasetBuildSpec,
  parseDatasetManifest,
  parseDatasetPublication,
  parseDatasetManifestV2,
  parseDatasetSchema,
  parseDatasetSchemaV2,
  parseSourceLocator,
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

  test("DatasetSchemaV2 requires independent required and nullable fields", () => {
    const field = {
      schema_version: "2.0",
      name: "target_id",
      data_type: "string",
      semantic_role: "entity_identifier",
      required: true,
      nullable: false,
      unit_policy: null,
      ontology: null,
      description: "",
      derivation_policy: null,
    };
    const parsed = parseDatasetSchemaV2({
      schema_version: "2.0",
      schema_id: "target.v2",
      dataset_family: "target_evidence",
      row_granularity: "target_record",
      primary_key: ["target_id"],
      fields: [field],
    });
    expect(parsed.fields[0]?.nullable).toBe(false);
    expect(() => parseDatasetSchemaV2({
      schema_version: "2.0",
      schema_id: "target.v2",
      dataset_family: "target_evidence",
      row_granularity: "target_record",
      primary_key: ["target_id"],
      fields: [{ ...field, nullable: undefined }],
    })).toThrow(/nullable/);
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

  test("Manifest 2.0 parses tables, relations and candidate refs", () => {
    const parsed = parseDatasetManifestV2({
      schema_version: "2.0",
      manifest_id: "manifest_v2",
      task_id: "task_1",
      build_id: "build_1",
      dataset_family: "target_evidence",
      row_granularity: "target_record",
      schema_ref: "target.v1",
      primary_key: ["target_id"],
      row_count: 1,
      sha256: "a".repeat(64),
      artifacts: [{
        artifact_id: "artifact_target",
        role: "primary_dataset",
        relative_path: "tables/target.csv",
        media_type: "text/csv",
        size_bytes: 10,
        sha256: "a".repeat(64),
      }],
      source_summary: {},
      validation_summary: {},
      confidence_summary: {},
      provenance_summary: {},
      tables: [{
        table_id: "targets",
        schema_ref: "target.v1",
        role: "primary",
        required: true,
        allow_empty: false,
        primary_key: ["target_id"],
        field_names: ["target_id", "name"],
      }, {
        table_id: "evidence",
        schema_ref: "evidence.v1",
        role: "supporting",
        required: true,
        allow_empty: false,
        primary_key: ["target_id", "source_id"],
        field_names: ["target_id", "source_id"],
      }],
      relations: [{
        relation_id: "evidence_target",
        from_table_id: "evidence",
        from_fields: ["target_id"],
        to_table_id: "targets",
        to_fields: ["target_id"],
        cardinality: "many_to_one",
        missing_policy: "reject",
      }],
      candidate_refs: [{
        candidate_id: "candidate_1",
        table_ids: ["targets", "evidence"],
        relation_ids: ["evidence_target"],
        provenance_refs: ["prov_1"],
        confidence_refs: ["confidence_1"],
        audit_refs: ["audit_1"],
      }],
    }, {
      knownSchemaRefs: new Set(["target.v1", "evidence.v1"]),
      schemaFieldsByRef: new Map([
        ["target.v1", new Set(["target_id", "name"])],
        ["evidence.v1", new Set(["target_id", "source_id"])],
      ]),
    });
    expect(parsed.schema_version).toBe("2.0");
    expect(parsed.tables).toHaveLength(2);
    expect(parsed.relations[0]?.cardinality).toBe("many_to_one");
  });

  test("Manifest 2.0 rejects duplicate tables, missing primary, bad FK and candidate refs", () => {
    const base = {
      schema_version: "2.0",
      manifest_id: "manifest_v2",
      task_id: "task_1",
      build_id: "build_1",
      dataset_family: "target_evidence",
      row_granularity: "target_record",
      schema_ref: "target.v1",
      primary_key: ["target_id"],
      row_count: 1,
      sha256: "a".repeat(64),
      artifacts: [],
      source_summary: {},
      validation_summary: {},
      confidence_summary: {},
      provenance_summary: {},
      tables: [{ table_id: "targets", schema_ref: "target.v1", role: "primary", required: true, allow_empty: false, primary_key: ["target_id"], field_names: ["target_id"] }],
      relations: [],
      candidate_refs: [{ candidate_id: "candidate_1", table_ids: ["targets"], relation_ids: [], provenance_refs: [], confidence_refs: [], audit_refs: [] }],
    };
    expect(() => parseDatasetManifestV2({ ...base, tables: [...base.tables, { ...base.tables[0] }] })).toThrow(/table IDs/);
    expect(() => parseDatasetManifestV2({ ...base, tables: [{ ...base.tables[0], role: "supporting" }] })).toThrow(/primary table/);
    expect(() => parseDatasetManifestV2({ ...base, tables: [{ ...base.tables[0], primary_key: ["missing"] }] })).toThrow(/primary_key/);
    expect(() => parseDatasetManifestV2({ ...base, relations: [{ relation_id: "bad", from_table_id: "targets", from_fields: ["missing"], to_table_id: "targets", to_fields: ["target_id"], cardinality: "one_to_one", missing_policy: "reject" }] })).toThrow(/unknown field/);
    expect(() => parseDatasetManifestV2({ ...base, candidate_refs: [{ ...base.candidate_refs[0], table_ids: ["missing"] }] })).toThrow(/unknown table/);
    expect(() => parseDatasetManifestV2({ ...base, tables: [{ ...base.tables[0], schema_ref: "unknown.v1" }] }, { knownSchemaRefs: new Set(["target.v1"]) })).toThrow(/unknown schema ref/);
    expect(() => parseDatasetManifestV2({ ...base, tables: [{ ...base.tables[0], field_names: ["target_id", "missing"] }] }, { schemaFieldsByRef: new Map([["target.v1", new Set(["target_id"])]]) })).toThrow(/unknown schema field/);
  });

  test("Manifest 1.0 rejects v2 fields instead of accepting a mixed version", () => {
    expect(() => parseDatasetManifest({
      manifest_id: "manifest_1",
      task_id: "task_1",
      build_id: "build_1",
      dataset_family: "gene_expression",
      row_granularity: "gene_sample_measurement",
      schema_ref: "gene_expression.long.v1",
      row_count: 0,
      sha256: "digest",
      artifacts: [],
      tables: [],
    })).toThrow(/unknown fields/);
  });

  test("SourceLocator 2.0 accepts JSON, XML, PDF and image coordinates", () => {
    expect(parseSourceLocator({ locator_version: "2.0", locator_type: "json_pointer", asset_id: "asset_1", logical_file: "response.json", raw_value: "EGFR", json_pointer: "/data/0/name" })).toMatchObject({ locator_type: "json_pointer" });
    expect(parseSourceLocator({ locator_version: "2.0", locator_type: "xml_cell", asset_id: "asset_1", logical_file: "article.xml", raw_value: "100", xml_path: "/article/table-wrap[1]", table_id: "T1", row_index: 1, column_index: 2 })).toMatchObject({ locator_type: "xml_cell" });
    expect(parseSourceLocator({ locator_version: "2.0", locator_type: "pdf_region", asset_id: "asset_1", logical_file: "article.pdf", raw_value: "IC50", page_number: 4, table_id: "Table 1", figure_id: null, row_label: "WT", column_label: "Gefitinib" })).toMatchObject({ locator_type: "pdf_region" });
    expect(parseSourceLocator({ locator_version: "2.0", locator_type: "image_bbox", asset_id: "asset_1", logical_file: "figure.png", raw_value: "0.5", page_number: null, figure_id: "Fig 2", bbox: [1, 2, 20, 30] })).toMatchObject({ locator_type: "image_bbox" });
    expect(() => parseSourceLocator({ locator_version: "2.0", locator_type: "json_pointer", asset_id: "asset_1", logical_file: "response.json", raw_value: "x", json_pointer: "data/0" })).toThrow(/json_pointer/);
    expect(() => parseSourceLocator({ locator_version: "2.0", locator_type: "image_bbox", asset_id: "asset_1", logical_file: "figure.png", raw_value: "x", page_number: null, figure_id: "Fig 2", bbox: [20, 2, 1, 30] })).toThrow(/coordinates/);
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

  test("DatasetPublication 1.1 requires the manifest file hash receipt (P7)", () => {
    const parsed = parseDatasetPublication({
      schema_version: "1.1",
      publication_id: "pub_1",
      manifest_ref: "manifest.json",
      manifest_sha256: "a".repeat(64),
      validation_result_ref: "validation.json",
      published_at: "2026-08-11T00:00:00Z",
      supersedes_publication_id: null,
    });
    expect(parsed.manifest_sha256).toBe("a".repeat(64));
    // A 1.1 record without the receipt must not parse.
    const missing = {
      schema_version: "1.1",
      publication_id: "pub_1",
      manifest_ref: "manifest.json",
      manifest_sha256: "",
      validation_result_ref: "validation.json",
      published_at: "2026-08-11T00:00:00Z",
      supersedes_publication_id: null,
    };
    expect(() => parseDatasetPublication(missing)).toThrow(/manifest_sha256/);
    expect(() => parseDatasetPublication({
      ...missing,
      manifest_sha256: "not-a-digest",
    })).toThrow(/SHA-256/);
    // A 1.0 record may not smuggle a receipt.
    expect(() => parseDatasetPublication({
      ...missing,
      schema_version: "1.0",
      manifest_sha256: "a".repeat(64),
    })).toThrow(/1\.0/);
  });

  test("DatasetPublication 1.0 (legacy) parses without a receipt", () => {
    const parsed = parseDatasetPublication({
      schema_version: "1.0",
      publication_id: "pub_1",
      manifest_ref: "manifest.json",
      validation_result_ref: "validation.json",
      published_at: "2026-08-11T00:00:00Z",
      supersedes_publication_id: null,
    });
    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.manifest_sha256).toBeUndefined();
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

  test("DatasetBuildSpec keeps target_entity_level family-neutral", () => {
    expect(parseDatasetBuildSpec({ ...spec, target_entity_level: "variant" }))
      .toMatchObject({ target_entity_level: "variant" });
    expect(() => parseDatasetBuildSpec({ ...spec, target_entity_level: "" }))
      .toThrow(/non-empty string/);
    expect(() => parseDatasetBuildSpec({ ...spec, target_entity_level: 1 }))
      .toThrow(/non-empty string/);
  });

  test("DatasetBuildSpec normalizes missing schema_version", () => {
    const withoutVersion: DatasetBuildSpec = { ...spec };
    delete withoutVersion.schema_version;
    expect(parseDatasetBuildSpec(withoutVersion).schema_version).toBe("1.0");
  });
});
