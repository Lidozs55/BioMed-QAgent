import type {
  DatasetSchemaV2,
  DeterministicDeriveResultReceipt,
  TableDefinition,
} from "@biomed/contracts";

import { canonicalDigest } from "../../adapters/identity.js";
import {
  assertExactKeys,
  assertJsonRecord,
  assertNonEmptyString,
  assertRecord,
  assertSha256,
} from "../../contracts/primitives.js";
import {
  parseDatasetSchemaV2,
  parseDeterministicDeriveResultReceipt,
  parseTableDefinition,
  parseValidationProfile,
} from "../../contracts/index.js";
import {
  SEQUENCE_ALIGNMENT_ALGORITHM_ID,
  SEQUENCE_REFERENCE_MAPPING_OUTPUT_SCHEMA_ID,
} from "../../derive/index.js";
import type { ValidationProfile } from "../../contracts/index.js";
import { VARIANT_EVIDENCE_FAMILY_ID } from "./types.js";

export const VARIANT_SEQUENCE_MAPPING_SCHEMA_ID =
  SEQUENCE_REFERENCE_MAPPING_OUTPUT_SCHEMA_ID;
export const VARIANT_SEQUENCE_MAPPING_PROFILE_ID =
  "variant_evidence.derived_mapping.release.v1";

const SUMMARY_KEYS = [
  "dataset_family",
  "evidence_origin",
  "row_count",
  "records",
  "parameter_digest",
  "reference_digest",
  "input_digests",
] as const;
const RECORD_KEYS = [
  "mapping_id",
  "query_sequence_id",
  "query_position",
  "reference_id",
  "reference_version",
  "query_residue",
  "reference_position",
  "reference_residue",
  "mapping_status",
  "evidence_origin",
  "request_identity_digest",
  "parameter_digest",
  "reference_digest",
  "input_digests",
] as const;

export type VariantSequenceMappingStatus = "match" | "mismatch" | "unmapped";

export interface VariantSequenceMappingDerivedRecord {
  mapping_id: string;
  query_sequence_id: string;
  query_position: number;
  reference_id: string;
  reference_version: string;
  query_residue: string;
  reference_position: number | null;
  reference_residue: string | null;
  mapping_status: VariantSequenceMappingStatus;
  evidence_origin: "deterministic_derive";
  request_identity_digest: string;
  parameter_digest: string;
  reference_digest: string;
  input_digests: string[];
}

export interface VariantSequenceMappingDerivedEvidence {
  schema: DatasetSchemaV2;
  table: TableDefinition;
  profile: ValidationProfile;
  records: VariantSequenceMappingDerivedRecord[];
  parameterDigest: string;
}

function field(
  name: string,
  dataType: string,
  semanticRole: string,
  description: string,
  nullable = false,
): DatasetSchemaV2["fields"][number] {
  return {
    schema_version: "2.0",
    name,
    data_type: dataType,
    semantic_role: semanticRole,
    required: true,
    nullable,
    unit_policy: null,
    ontology: null,
    description,
    derivation_policy: `deterministic_derive:${SEQUENCE_ALIGNMENT_ALGORITHM_ID}`,
  };
}

export function buildVariantSequenceMappingSchema(): DatasetSchemaV2 {
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: VARIANT_SEQUENCE_MAPPING_SCHEMA_ID,
    dataset_family: VARIANT_EVIDENCE_FAMILY_ID,
    row_granularity: "one query sequence position mapped to a declared reference sequence",
    primary_key: ["mapping_id"],
    fields: [
      field("mapping_id", "string", "row_identifier", "Stable identity of one derived sequence mapping."),
      field("query_sequence_id", "string", "entity_identifier", "Identifier of the canonical query sequence."),
      field("query_position", "integer", "query_coordinate", "One-based position on the query sequence."),
      field("reference_id", "string", "reference_identifier", "Reference sequence identifier."),
      field("reference_version", "string", "reference_version", "Exact reference sequence version used by alignment."),
      field("query_residue", "string", "query_allele", "Residue or base at the query position."),
      field("reference_position", "integer", "reference_coordinate", "One-based reference position, or null for an insertion.", true),
      field("reference_residue", "string", "reference_allele", "Reference residue, or null for an insertion.", true),
      field("mapping_status", "string", "mapping_status", "Controlled match, mismatch, or unmapped status."),
      field("evidence_origin", "string", "evidence_origin", "Explicit derived origin; never a source assertion."),
      field("request_identity_digest", "string", "derive_request_identity", "Digest covering algorithm, parameters, reference, inputs, and schema."),
      field("parameter_digest", "string", "derive_parameter_digest", "Digest of the declared alignment parameters."),
      field("reference_digest", "string", "derive_reference_digest", "Digest of the exact reference sequence."),
      field("input_digests", "json", "derive_input_digests", "Ordered digests of committed Core or registered asset inputs."),
    ],
  });
}

export function buildVariantSequenceMappingTable(): TableDefinition {
  const schema = buildVariantSequenceMappingSchema();
  return parseTableDefinition({
    table_id: "derived_sequence_mappings",
    schema_ref: schema.schema_id,
    role: "derived",
    required: true,
    allow_empty: false,
    primary_key: [...schema.primary_key],
    field_names: schema.fields.map((item) => item.name),
  });
}

export function variantSequenceMappingProfile(): ValidationProfile {
  return parseValidationProfile({
    profile_id: VARIANT_SEQUENCE_MAPPING_PROFILE_ID,
    dataset_family: VARIANT_EVIDENCE_FAMILY_ID,
    acceptance: {
      minimum_valid_rows: 1,
      allow_empty_primary_dataset: false,
      allow_partial_publish: false,
    },
    description: "Require non-empty sequence mappings with closed deterministic derive provenance.",
    required_entity_level: "any",
    confidence_gate: {
      block_pending_human_review: true,
      required_fields_min_level: "high",
      allow_low_confidence_primary: false,
      max_low_confidence_fraction: 0,
      require_review_for_channels: ["vlm", "llm", "ocr", "web_extraction"],
    },
  });
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty array`);
  }
  return value.map((item, index) => assertSha256(item, `${name}[${index}]`));
}

function position(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive integer or null`);
  }
  return value as number;
}

function residue(value: unknown, name: string): string | null {
  if (value === null) return null;
  return assertNonEmptyString(value, name);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value as number;
}

function parseRecord(
  value: unknown,
  receipt: DeterministicDeriveResultReceipt,
  parameterDigest: string,
): VariantSequenceMappingDerivedRecord {
  const record = assertRecord(value, "variant sequence mapping record");
  assertExactKeys(record, RECORD_KEYS, "variant sequence mapping record");
  if (record.evidence_origin !== "deterministic_derive") {
    throw new TypeError("variant sequence mapping must keep deterministic_derive origin");
  }
  const inputDigests = stringArray(record.input_digests, "mapping input_digests");
  const expectedInputs = receipt.provenance.inputs.map((input) => input.digest);
  if (JSON.stringify(inputDigests) !== JSON.stringify(expectedInputs)) {
    throw new TypeError("variant sequence mapping input digests do not match provenance");
  }
  const requestIdentityDigest = assertSha256(record.request_identity_digest, "mapping request identity digest");
  if (requestIdentityDigest !== receipt.request_identity_digest) {
    throw new TypeError("variant sequence mapping request identity digest does not match receipt");
  }
  if (assertSha256(record.parameter_digest, "mapping parameter digest") !== parameterDigest) {
    throw new TypeError("variant sequence mapping parameter digest does not match parameters");
  }
  if (assertSha256(record.reference_digest, "mapping reference digest") !== receipt.provenance.reference.digest) {
    throw new TypeError("variant sequence mapping reference digest does not match provenance");
  }
  const referencePosition = position(record.reference_position, "reference_position");
  const referenceResidue = residue(record.reference_residue, "reference_residue");
  const status = record.mapping_status;
  if (status !== "match" && status !== "mismatch" && status !== "unmapped") {
    throw new TypeError("variant sequence mapping status is not controlled");
  }
  if (status === "unmapped" && (referencePosition !== null || referenceResidue !== null)) {
    throw new TypeError("unmapped sequence mapping must not carry a reference coordinate");
  }
  if (status !== "unmapped" && (referencePosition === null || referenceResidue === null)) {
    throw new TypeError("mapped sequence mapping requires a reference coordinate and residue");
  }
  return {
    mapping_id: assertNonEmptyString(record.mapping_id, "mapping_id"),
    query_sequence_id: assertNonEmptyString(record.query_sequence_id, "query_sequence_id"),
    query_position: position(record.query_position, "query_position")!,
    reference_id: assertNonEmptyString(record.reference_id, "reference_id"),
    reference_version: assertNonEmptyString(record.reference_version, "reference_version"),
    query_residue: assertNonEmptyString(record.query_residue, "query_residue"),
    reference_position: referencePosition,
    reference_residue: referenceResidue,
    mapping_status: status,
    evidence_origin: "deterministic_derive",
    request_identity_digest: requestIdentityDigest,
    parameter_digest: parameterDigest,
    reference_digest: receipt.provenance.reference.digest,
    input_digests: inputDigests,
  };
}

export function consumeVariantSequenceMappingEvidence(
  value: DeterministicDeriveResultReceipt,
): VariantSequenceMappingDerivedEvidence {
  const receipt = parseDeterministicDeriveResultReceipt(value);
  if (receipt.provenance.algorithm_id !== SEQUENCE_ALIGNMENT_ALGORITHM_ID) {
    throw new TypeError("variant evidence derived mapping requires the sequence alignment algorithm");
  }
  if (receipt.output_schema_ref !== VARIANT_SEQUENCE_MAPPING_SCHEMA_ID) {
    throw new TypeError("variant evidence derived mapping uses an unknown output schema");
  }
  const summary = assertJsonRecord(receipt.output_summary, "variant derived output summary");
  assertExactKeys(summary, SUMMARY_KEYS, "variant derived output fields");
  if (summary.dataset_family !== VARIANT_EVIDENCE_FAMILY_ID || summary.evidence_origin !== "deterministic_derive") {
    throw new TypeError("variant derived output must retain its family and derived origin");
  }
  const parameterDigest = canonicalDigest(receipt.provenance.parameters);
  if (assertSha256(summary.parameter_digest, "derived summary parameter digest") !== parameterDigest) {
    throw new TypeError("variant derived summary parameter digest does not match provenance");
  }
  if (assertSha256(summary.reference_digest, "derived summary reference digest") !== receipt.provenance.reference.digest) {
    throw new TypeError("variant derived summary reference digest does not match provenance");
  }
  const inputDigests = stringArray(summary.input_digests, "derived summary input_digests");
  if (JSON.stringify(inputDigests) !== JSON.stringify(receipt.provenance.inputs.map((input) => input.digest))) {
    throw new TypeError("variant derived summary input digests do not match provenance");
  }
  const rowCount = positiveInteger(summary.row_count, "variant derived output row_count");
  if (!Array.isArray(summary.records) || summary.records.length !== rowCount) {
    throw new TypeError("variant derived output row_count does not match records");
  }
  if (canonicalDigest(summary) !== receipt.output_digest) {
    throw new TypeError("variant derived output digest does not match its records");
  }
  return {
    schema: buildVariantSequenceMappingSchema(),
    table: buildVariantSequenceMappingTable(),
    profile: variantSequenceMappingProfile(),
    records: summary.records.map((record) => parseRecord(record, receipt, parameterDigest)),
    parameterDigest,
  };
}
