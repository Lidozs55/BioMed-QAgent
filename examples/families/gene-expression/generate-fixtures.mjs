import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeFamilySpecDigest,
  parseFamilySpec,
} from "../../../packages/contracts/dist/index.js";
import {
  assetIdFromSha256,
  canonicalDigest,
  makeRecordId,
} from "../../../server/dist/dataset/adapters/identity.js";
import {
  createDatasetIdentityRecords,
  createSampleIdentity,
} from "../../../server/dist/dataset/identity/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JSON_INDENT = 2;

function json(value) {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(headers, rows) {
  return `${[headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\n")}\n`;
}

function parseSimpleCsv(text) {
  const lines = text.trimEnd().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => Object.fromEntries(
    line.split(",").map((value, index) => [headers[index], value]),
  ));
}

const GENE_FIELDS = [
  "record_id",
  "dataset_id",
  "dataset_revision_id",
  "source_id",
  "asset_id",
  "gene_id_raw",
  "gene_id",
  "gene_id_namespace",
  "gene_id_version",
  "sample_id",
  "source_sample_alias",
  "measurement_type",
  "value_semantics",
  "value_scale",
  "is_normalized",
  "is_integer_expected",
  "expression_value",
  "expression_unit",
  "source_logical_file",
  "source_line_number",
  "source_column_index",
  "source_column_name",
  "source_raw_value",
];

const PROBE_FIELDS = [
  "record_id",
  "dataset_id",
  "dataset_revision_id",
  "source_id",
  "asset_id",
  "probe_id",
  "platform_id",
  "sample_id",
  "value",
  "gene_id_namespace",
  "value_semantics",
  "value_scale",
  "expression_unit",
  "is_normalized",
  "is_integer_expected",
  "source_sample_alias",
  "measurement_type",
  "source_logical_file",
  "source_line_number",
  "source_column_index",
  "source_column_name",
  "source_raw_value",
];

const SAMPLE_FIELDS = [
  "dataset_revision_id",
  "sample_id",
  "source_sample_alias",
  "taxon",
  "platform_id",
  "source_locator",
];

const DATASET_FIELDS = [
  "dataset_id",
  "dataset_revision_id",
  "source_namespace",
  "canonical_accession",
  "revision_token",
  "provider_snapshot",
  "carrier_asset_ids",
  "source_locator",
];

const MAPPING_FIELDS = [
  "mapping_assertion_id",
  "dataset_revision_id",
  "mapping_scope_id",
  "platform_id",
  "probe_id",
  "target_gene_id",
  "target_namespace",
  "annotation_asset_id",
  "mapping_rule_id",
  "mapping_status",
];

const FAMILY_SPEC_BODY = {
  family_spec_id: "gene_expression.reference",
  semantic_version: "2.0.0",
  projections: [
    {
      projection_id: "expression_gene.v2",
      schema_version: "2.0",
      primary_tables: ["gene_expression"],
      supporting_tables: ["gene_samples", "gene_datasets"],
      derived_tables: [],
      required: ["gene_expression", "gene_samples", "gene_datasets"],
      optional: [],
      allow_empty: [],
      relations: ["gene_expression_samples", "gene_expression_datasets"],
      row_granularity: "gene_sample_measurement",
      compatibility_dimensions: [
        "schema_ref",
        "row_granularity",
        "taxon",
        "reference_version",
        "gene_id_namespace",
        "measurement_type",
        "value_semantics",
        "value_scale",
        "expression_unit",
        "is_normalized",
      ],
      merge_identity_fields: [
        "dataset_revision_id",
        "sample_id",
        "gene_id",
        "measurement_type",
      ],
      validation_policy_ref: "example:gene_expression.gene.validation.v2",
      assessment_policy_ref: "example:gene_expression.gene.assessment.v2",
    },
    {
      projection_id: "expression_probe.v2",
      schema_version: "2.0",
      primary_tables: ["probe_expression"],
      supporting_tables: ["probe_samples", "probe_datasets", "probe_gene_mapping"],
      derived_tables: [],
      required: ["probe_expression", "probe_samples", "probe_datasets", "probe_gene_mapping"],
      optional: [],
      allow_empty: [],
      relations: [
        "probe_expression_samples",
        "probe_expression_datasets",
        "probe_expression_mapping_coverage",
      ],
      row_granularity: "probe_sample_measurement",
      compatibility_dimensions: [
        "schema_ref",
        "row_granularity",
        "taxon",
        "reference_version",
        "platform_id",
        "gene_id_namespace",
        "measurement_type",
        "value_semantics",
        "value_scale",
        "expression_unit",
        "is_normalized",
      ],
      merge_identity_fields: [
        "dataset_revision_id",
        "probe_id",
        "platform_id",
        "sample_id",
      ],
      validation_policy_ref: "example:gene_expression.probe.validation.v2",
      assessment_policy_ref: "example:gene_expression.probe.assessment.v2",
    },
  ],
  table_definitions: [
    {
      table_id: "gene_expression",
      schema_ref: "gene_expression.long.v2",
      role: "primary",
      required: true,
      allow_empty: false,
      primary_key: ["dataset_revision_id", "sample_id", "gene_id", "measurement_type"],
      field_names: GENE_FIELDS,
    },
    {
      table_id: "gene_samples",
      schema_ref: "expression_samples.v2",
      role: "supporting",
      required: true,
      allow_empty: false,
      primary_key: ["dataset_revision_id", "sample_id"],
      field_names: SAMPLE_FIELDS,
    },
    {
      table_id: "gene_datasets",
      schema_ref: "expression_datasets.v2",
      role: "supporting",
      required: true,
      allow_empty: false,
      primary_key: ["dataset_revision_id"],
      field_names: DATASET_FIELDS,
    },
    {
      table_id: "probe_expression",
      schema_ref: "gene_expression.probe_long.v2",
      role: "primary",
      required: true,
      allow_empty: false,
      primary_key: ["dataset_revision_id", "probe_id", "platform_id", "sample_id"],
      field_names: PROBE_FIELDS,
    },
    {
      table_id: "probe_samples",
      schema_ref: "expression_probe_samples.v2",
      role: "supporting",
      required: true,
      allow_empty: false,
      primary_key: ["dataset_revision_id", "sample_id"],
      field_names: SAMPLE_FIELDS,
    },
    {
      table_id: "probe_datasets",
      schema_ref: "expression_probe_datasets.v2",
      role: "supporting",
      required: true,
      allow_empty: false,
      primary_key: ["dataset_revision_id"],
      field_names: DATASET_FIELDS,
    },
    {
      table_id: "probe_gene_mapping",
      schema_ref: "probe_mapping_assertion.v1",
      role: "supporting",
      required: true,
      allow_empty: false,
      primary_key: ["mapping_assertion_id"],
      field_names: MAPPING_FIELDS,
    },
  ],
  relations: [
    {
      relation_id: "gene_expression_samples",
      from_table_id: "gene_expression",
      from_fields: ["dataset_revision_id", "sample_id"],
      to_table_id: "gene_samples",
      to_fields: ["dataset_revision_id", "sample_id"],
      cardinality: "many_to_one",
      missing_policy: "reject",
    },
    {
      relation_id: "gene_expression_datasets",
      from_table_id: "gene_expression",
      from_fields: ["dataset_revision_id"],
      to_table_id: "gene_datasets",
      to_fields: ["dataset_revision_id"],
      cardinality: "many_to_one",
      missing_policy: "reject",
    },
    {
      relation_id: "probe_expression_samples",
      from_table_id: "probe_expression",
      from_fields: ["dataset_revision_id", "sample_id"],
      to_table_id: "probe_samples",
      to_fields: ["dataset_revision_id", "sample_id"],
      cardinality: "many_to_one",
      missing_policy: "reject",
    },
    {
      relation_id: "probe_expression_datasets",
      from_table_id: "probe_expression",
      from_fields: ["dataset_revision_id"],
      to_table_id: "probe_datasets",
      to_fields: ["dataset_revision_id"],
      cardinality: "many_to_one",
      missing_policy: "reject",
    },
    {
      relation_id: "probe_expression_mapping_coverage",
      from_table_id: "probe_expression",
      from_fields: ["dataset_revision_id", "platform_id", "probe_id"],
      to_table_id: "probe_gene_mapping",
      to_fields: ["dataset_revision_id", "platform_id", "probe_id"],
      cardinality: "many_to_many",
      missing_policy: "reject",
    },
  ],
  identity: {
    dataset_id_scheme: "ds_hash",
    dataset_revision_id_scheme: "dsrev_hash",
    asset_id_scheme: "asset_sha256",
    sample_identity_fields: ["dataset_revision_id", "sample_id"],
    probe_mapping_assertion_pk: "mapping_assertion_id",
  },
  transform_capability_refs: [],
  declared_outputs: [
    { table_id: "gene_expression", schema_ref: "gene_expression.long.v2" },
    { table_id: "gene_samples", schema_ref: "expression_samples.v2" },
    { table_id: "gene_datasets", schema_ref: "expression_datasets.v2" },
    { table_id: "probe_expression", schema_ref: "gene_expression.probe_long.v2" },
    { table_id: "probe_samples", schema_ref: "expression_probe_samples.v2" },
    { table_id: "probe_datasets", schema_ref: "expression_probe_datasets.v2" },
    { table_id: "probe_gene_mapping", schema_ref: "probe_mapping_assertion.v1" },
  ],
  integration_policy_ref: "example:gene_expression.partitioned.integration.v2",
  validation_policy_ref: "example:gene_expression.validation.v2",
  assessment_policy_ref: "example:gene_expression.assessment.v2",
  resource_class_request: "none",
  scope: "example",
  author: "BioMed-QAgent static retrieval example",
  evidence_refs: [
    "example-evidence:geo-gene-source-sketch",
    "example-evidence:geo-probe-source-sketch",
    "example-evidence:gdc-gene-source-sketch",
  ],
};

const VARIANTS = [
  {
    id: "geo-gene",
    sourceNamespace: "geo",
    accessions: ["GSE178352"],
    providerSnapshot: "geo:GSE178352:example-snapshot-v1",
    platformId: "GPL570",
    projectionRef: "expression_gene.v2",
    probeMappingSupport: "not_applicable",
    matrixPath: "geo-gene/fixtures/input/series-matrix.csv",
    matrix: "gene_id,GSM1001,GSM1002\nENSG00000141510,1.5,2.0\nENSG00000012048,3.0,4.0\n",
    featureColumn: "gene_id",
    measurement: {
      measurement_type: "series_matrix_expression",
      value_semantics: "normalized_expression_value",
      value_scale: "log2",
      expression_unit: "normalized_expression_value",
      is_normalized: true,
      is_integer_expected: false,
    },
  },
  {
    id: "geo-probe",
    sourceNamespace: "geo",
    accessions: ["GSE178352"],
    providerSnapshot: "geo:GSE178352+GPL570:example-snapshot-v1",
    platformId: "GPL570",
    projectionRef: "expression_probe.v2",
    probeMappingSupport: "supported_with_assertions",
    matrixPath: "geo-probe/fixtures/input/series-matrix.csv",
    matrix: "probe_id,GSM1001,GSM1002\n1007_s_at,1.5,2.0\n1053_at,3.0,4.0\n117_at,5.0,6.0\n121_at,7.0,8.0\n",
    featureColumn: "probe_id",
    annotationPath: "geo-probe/fixtures/input/gpl570-annotation.csv",
    annotation: "probe_id,target_gene_id,target_namespace,mapping_rule_id,mapping_status\n1007_s_at,DDR1,gene_symbol,geo.gpl570.annotation.v1,mapped\n1053_at,,,geo.gpl570.annotation.v1,unmapped\n117_at,HSPA6,gene_symbol,geo.gpl570.annotation.v1,ambiguous\n117_at,HSPA7,gene_symbol,geo.gpl570.annotation.v1,ambiguous\n121_at,PAX8,gene_symbol,geo.gpl570.annotation.v1,mapped\n",
    measurement: {
      measurement_type: "series_matrix_expression",
      value_semantics: "normalized_expression_value",
      value_scale: "log2",
      expression_unit: "normalized_expression_value",
      is_normalized: true,
      is_integer_expected: false,
    },
  },
  {
    id: "gdc-gene",
    sourceNamespace: "gdc",
    accessions: ["TCGA-LUAD"],
    providerSnapshot: "gdc:TCGA-LUAD:example-snapshot-v1",
    platformId: "",
    projectionRef: "expression_gene.v2",
    probeMappingSupport: "unsupported",
    matrixPath: "gdc-gene/fixtures/input/gene-expression.csv",
    matrix: "gene_id,TCGA-55-7570-01A,TCGA-55-7726-01A\nENSG00000141510,10,14\nENSG00000012048,5,8\n",
    featureColumn: "gene_id",
    measurement: {
      measurement_type: "gene_expression_quantification",
      value_semantics: "raw_count",
      value_scale: "linear",
      expression_unit: "count",
      is_normalized: false,
      is_integer_expected: true,
    },
  },
];

function carrier(pathname, bytes) {
  const digest = sha256(bytes);
  return {
    path: pathname,
    media_type: "text/csv",
    sha256: digest,
    asset_id: assetIdFromSha256(digest),
    source_locator: `example://${pathname}`,
  };
}

function receipt(pathname, role, bytes) {
  return {
    path: pathname,
    role,
    sha256: sha256(bytes),
    size_bytes: Buffer.byteLength(bytes),
  };
}

function sourceSketch(variant) {
  const sampleHeaders = parseSimpleCsv(variant.matrix)[0];
  return {
    schema_version: "1.0",
    sketch_id: `${variant.id}.retrieval-source-sketch`,
    scope: "example",
    status: "submitted",
    executable: false,
    source_database: variant.sourceNamespace,
    source_level: variant.projectionRef === "expression_probe.v2" ? "probe" : "gene",
    projection_ref: variant.projectionRef,
    carrier_shapes: [
      {
        role: "expression_matrix",
        path: variant.matrixPath,
        identifier_column: variant.featureColumn,
        sample_columns: Object.keys(sampleHeaders).filter((header) => header !== variant.featureColumn),
      },
      ...(variant.annotationPath === undefined ? [] : [{
        role: "probe_annotation",
        path: variant.annotationPath,
        required_columns: [
          "probe_id",
          "target_gene_id",
          "target_namespace",
          "mapping_rule_id",
          "mapping_status",
        ],
      }]),
    ],
    retrieval_guidance: [
      "Preserve source identifiers and raw values before normalization.",
      "Hash every carrier byte-for-byte before deriving revision identity.",
      "Keep gene-level and probe-level rows in separate projections.",
    ],
    probe_level_supported: variant.id === "geo-probe",
  };
}

function makeVariantArtifacts(variant) {
  const artifacts = new Map([[variant.matrixPath, variant.matrix]]);
  if (variant.annotationPath !== undefined) artifacts.set(variant.annotationPath, variant.annotation);

  const carriers = [carrier(variant.matrixPath, variant.matrix)];
  if (variant.annotationPath !== undefined) carriers.push(carrier(variant.annotationPath, variant.annotation));
  const matrixCarrier = carriers[0];
  const identityRecords = createDatasetIdentityRecords({
    sourceNamespace: variant.sourceNamespace,
    canonicalAccessions: variant.accessions,
    revisionToken: null,
    providerSnapshot: variant.providerSnapshot,
    carrierAssetIds: carriers.map((item) => item.asset_id),
  });
  const datasetId = identityRecords[0].dataset_id;
  const datasetRevisionId = identityRecords[0].dataset_revision_id;
  const matrixRows = parseSimpleCsv(variant.matrix);
  const sampleIds = Object.keys(matrixRows[0]).filter((header) => header !== variant.featureColumn);
  const sampleIdentities = sampleIds.map((sampleId) => createSampleIdentity({ datasetRevisionId, sampleId }));

  const datasetsRows = [{
    dataset_id: datasetId,
    dataset_revision_id: datasetRevisionId,
    source_namespace: variant.sourceNamespace,
    canonical_accession: variant.accessions.join("|"),
    revision_token: "",
    provider_snapshot: variant.providerSnapshot,
    carrier_asset_ids: identityRecords.map((item) => item.asset_id).join("|"),
    source_locator: `example://${variant.id}/fixtures/input#dataset`,
  }];
  const sampleRows = sampleIds.map((sampleId) => ({
    dataset_revision_id: datasetRevisionId,
    sample_id: sampleId,
    source_sample_alias: sampleId,
    taxon: "Homo sapiens",
    platform_id: variant.platformId,
    source_locator: `example://${variant.matrixPath}#column=${sampleId}`,
  }));

  const expressionRows = matrixRows.flatMap((sourceRow, rowIndex) => sampleIds.map((sampleId, sampleIndex) => {
    const rawFeature = sourceRow[variant.featureColumn];
    const common = {
      record_id: makeRecordId(datasetId, rawFeature, sampleId),
      dataset_id: datasetId,
      dataset_revision_id: datasetRevisionId,
      source_id: variant.sourceNamespace,
      asset_id: matrixCarrier.asset_id,
      sample_id: sampleId,
      source_sample_alias: sampleId,
      ...variant.measurement,
      source_logical_file: variant.matrixPath,
      source_line_number: rowIndex + 2,
      source_column_index: sampleIndex + 2,
      source_column_name: sampleId,
      source_raw_value: sourceRow[sampleId],
    };
    return variant.projectionRef === "expression_probe.v2"
      ? {
          ...common,
          probe_id: rawFeature,
          platform_id: variant.platformId,
          value: sourceRow[sampleId],
          gene_id_namespace: "geo_probe",
        }
      : {
          ...common,
          gene_id_raw: rawFeature,
          gene_id: rawFeature,
          gene_id_namespace: "ensembl_gene",
          gene_id_version: "",
          expression_value: sourceRow[sampleId],
        };
  }));

  const expectedRoot = `${variant.id}/fixtures/expected`;
  const expressionPath = `${expectedRoot}/expression.csv`;
  const samplesPath = `${expectedRoot}/samples.csv`;
  const datasetsPath = `${expectedRoot}/datasets.csv`;
  artifacts.set(expressionPath, csv(
    variant.projectionRef === "expression_probe.v2" ? PROBE_FIELDS : GENE_FIELDS,
    expressionRows,
  ));
  artifacts.set(samplesPath, csv(SAMPLE_FIELDS, sampleRows));
  artifacts.set(datasetsPath, csv(DATASET_FIELDS, datasetsRows));

  let mappingRows = [];
  if (variant.annotationPath !== undefined) {
    const annotationCarrier = carriers.find((item) => item.path === variant.annotationPath);
    const annotationRows = parseSimpleCsv(variant.annotation);
    const mappingRuleId = annotationRows[0].mapping_rule_id;
    const mappingScopeId = `mapscope_${canonicalDigest({
      dataset_revision_id: datasetRevisionId,
      platform_id: variant.platformId,
      annotation_asset_id: annotationCarrier.asset_id,
      mapping_rule_id: mappingRuleId,
    })}`;
    mappingRows = annotationRows.map((row) => {
      const assertionBody = {
        dataset_revision_id: datasetRevisionId,
        mapping_scope_id: mappingScopeId,
        platform_id: variant.platformId,
        probe_id: row.probe_id,
        target_gene_id: row.target_gene_id || null,
        target_namespace: row.target_namespace || null,
        annotation_asset_id: annotationCarrier.asset_id,
        mapping_rule_id: row.mapping_rule_id,
        mapping_status: row.mapping_status,
      };
      return {
        mapping_assertion_id: `mapassert_${canonicalDigest(assertionBody)}`,
        ...assertionBody,
      };
    });
    artifacts.set(`${expectedRoot}/probe_gene_mapping.csv`, csv(MAPPING_FIELDS, mappingRows));
  }

  const identityPath = `${variant.id}/identity.json`;
  artifacts.set(identityPath, json({
    schema_version: "1.0",
    source_namespace: variant.sourceNamespace,
    canonical_accessions: variant.accessions,
    revision_token: null,
    provider_snapshot: variant.providerSnapshot,
    carrier_assets: carriers,
    dataset_identity_records: identityRecords,
    sample_identities: sampleIdentities,
  }));

  const identityAssertions = {
    schema_version: "1.0",
    projection_ref: variant.projectionRef,
    dataset_id: datasetId,
    dataset_revision_id: datasetRevisionId,
    carrier_asset_ids: identityRecords.map((item) => item.asset_id),
    primary_key_fields: variant.projectionRef === "expression_probe.v2"
      ? ["dataset_revision_id", "probe_id", "platform_id", "sample_id"]
      : ["dataset_revision_id", "sample_id", "gene_id", "measurement_type"],
    expected_expression_rows: expressionRows.length,
  };
  artifacts.set(`${variant.id}/identity-assertions.json`, json(identityAssertions));

  if (variant.annotationPath !== undefined) {
    const statusCounts = Object.fromEntries(["mapped", "unmapped", "ambiguous"].map((status) => [
      status,
      mappingRows.filter((row) => row.mapping_status === status).length,
    ]));
    artifacts.set(`${variant.id}/probe-mapping-assertions.json`, json({
      schema_version: "1.0",
      annotation_asset_id: carriers[1].asset_id,
      expected_mapping_rows: mappingRows.length,
      expected_expression_probes: new Set(expressionRows.map((row) => row.probe_id)).size,
      mapping_status_counts: statusCounts,
      every_expression_probe_has_mapping_assertion: true,
    }));
  }

  const sketchPath = `${variant.id}/retrieval-source-sketch.json`;
  artifacts.set(sketchPath, json(sourceSketch(variant)));

  const receiptPaths = [...artifacts.keys()].filter((pathname) =>
    pathname.includes("/fixtures/input/") || pathname.includes("/fixtures/expected/"),
  );
  artifacts.set(`${variant.id}/retrieval-metadata.json`, json({
    schema_version: "1.0",
    example_id: variant.id,
    scope: "example",
    status: "submitted",
    executable: false,
    projection_ref: variant.projectionRef,
    probe_mapping_support: variant.probeMappingSupport,
    identity_ref: identityPath,
    source_sketch_ref: sketchPath,
    artifacts: receiptPaths.map((pathname) => receipt(
      pathname,
      pathname.includes("/input/") ? "source_carrier" : "expected_v2_table",
      artifacts.get(pathname),
    )),
  }));

  return artifacts;
}

export async function buildArtifacts() {
  const placeholder = parseFamilySpec(
    { ...FAMILY_SPEC_BODY, canonical_digest: "0".repeat(64) },
    "$family_spec",
  );
  const familySpec = {
    ...FAMILY_SPEC_BODY,
    canonical_digest: await computeFamilySpecDigest(placeholder),
  };
  const artifacts = new Map([
    ["family-spec.example.json", json(familySpec)],
    ["catalog.json", json({
      schema_version: "1.0",
      catalog_id: "gene-expression.retrieval-examples",
      scope: "example",
      status: "submitted",
      executable: false,
      entries: [{
        kind: "family_spec",
        metadata_only: true,
        scope: "example",
        id: familySpec.family_spec_id,
        version: familySpec.semantic_version,
        digest: familySpec.canonical_digest,
        status: "submitted",
        executable: false,
      }],
    })],
  ]);
  for (const variant of VARIANTS) {
    for (const [pathname, bytes] of makeVariantArtifacts(variant)) artifacts.set(pathname, bytes);
  }
  return new Map([...artifacts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function writeArtifacts(artifacts) {
  for (const [pathname, bytes] of artifacts) {
    const destination = path.join(ROOT, pathname);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, "utf8");
  }
}

async function verifyArtifacts(artifacts) {
  const drift = [];
  for (const [pathname, expected] of artifacts) {
    let actual;
    try {
      actual = await readFile(path.join(ROOT, pathname), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        drift.push(`${pathname} (missing)`);
        continue;
      }
      throw error;
    }
    if (actual !== expected) drift.push(pathname);
  }
  if (drift.length > 0) throw new Error(`Generated artifact drift:\n${drift.join("\n")}`);
}

async function main() {
  const artifacts = await buildArtifacts();
  if (process.argv.includes("--write")) {
    await writeArtifacts(artifacts);
    console.log(`Wrote ${artifacts.size} retrieval artifacts.`);
    return;
  }
  await verifyArtifacts(artifacts);
  console.log(`Verified ${artifacts.size} retrieval artifacts without writing.`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
