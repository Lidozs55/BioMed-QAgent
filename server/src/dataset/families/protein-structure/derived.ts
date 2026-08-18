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
  PDB_INTERFACE_DISTANCE_ALGORITHM_ID,
  PDB_INTERFACE_DISTANCE_OUTPUT_SCHEMA_ID,
} from "../../derive/index.js";
import type { ValidationProfile } from "../../contracts/index.js";
import { PROTEIN_STRUCTURE_FAMILY_ID } from "./types.js";

export const PROTEIN_STRUCTURE_INTERFACE_SCHEMA_ID =
  PDB_INTERFACE_DISTANCE_OUTPUT_SCHEMA_ID;
export const PROTEIN_STRUCTURE_DERIVED_PROFILE_ID =
  "protein_structure.derived_interface.release.v1";

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
  "interface_record_id",
  "structure_id",
  "structure_version",
  "chain_a",
  "residue_a",
  "atom_a",
  "chain_b",
  "residue_b",
  "atom_b",
  "distance_angstrom",
  "cutoff_angstrom",
  "evidence_origin",
  "request_identity_digest",
  "parameter_digest",
  "reference_digest",
  "input_digests",
] as const;

export interface ProteinStructureInterfaceDerivedRecord {
  interface_record_id: string;
  structure_id: string;
  structure_version: string;
  chain_a: string;
  residue_a: string;
  atom_a: string;
  chain_b: string;
  residue_b: string;
  atom_b: string;
  distance_angstrom: number;
  cutoff_angstrom: number;
  evidence_origin: "deterministic_derive";
  request_identity_digest: string;
  parameter_digest: string;
  reference_digest: string;
  input_digests: string[];
}

export interface ProteinStructureDerivedEvidence {
  schema: DatasetSchemaV2;
  table: TableDefinition;
  profile: ValidationProfile;
  records: ProteinStructureInterfaceDerivedRecord[];
  parameterDigest: string;
}

function field(
  name: string,
  dataType: string,
  semanticRole: string,
  description: string,
): DatasetSchemaV2["fields"][number] {
  return {
    schema_version: "2.0",
    name,
    data_type: dataType,
    semantic_role: semanticRole,
    required: true,
    nullable: false,
    unit_policy: name === "distance_angstrom" || name === "cutoff_angstrom"
      ? "angstrom"
      : null,
    ontology: null,
    description,
    derivation_policy: `deterministic_derive:${PDB_INTERFACE_DISTANCE_ALGORITHM_ID}`,
  };
}

export function buildProteinStructureInterfaceDerivedSchema(): DatasetSchemaV2 {
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: PROTEIN_STRUCTURE_INTERFACE_SCHEMA_ID,
    dataset_family: PROTEIN_STRUCTURE_FAMILY_ID,
    row_granularity: "one atom pair within a declared PDB interface distance cutoff",
    primary_key: ["interface_record_id"],
    fields: [
      field("interface_record_id", "string", "row_identifier", "Stable identity of one derived atom-pair distance."),
      field("structure_id", "string", "foreign_key", "PDB structure containing the measured interface."),
      field("structure_version", "string", "reference_version", "Exact PDB structure revision used for the computation."),
      field("chain_a", "string", "dimension_identifier", "First interface chain identifier."),
      field("residue_a", "string", "residue_identifier", "First residue token preserved from the coordinate input."),
      field("atom_a", "string", "atom_identifier", "First atom name preserved from the coordinate input."),
      field("chain_b", "string", "dimension_identifier", "Second interface chain identifier."),
      field("residue_b", "string", "residue_identifier", "Second residue token preserved from the coordinate input."),
      field("atom_b", "string", "atom_identifier", "Second atom name preserved from the coordinate input."),
      field("distance_angstrom", "float", "derived_measurement", "Euclidean atom distance computed in angstroms."),
      field("cutoff_angstrom", "float", "derive_parameter", "Inclusive interface distance cutoff used for this record."),
      field("evidence_origin", "string", "evidence_origin", "Explicit derived origin; never a source record."),
      field("request_identity_digest", "string", "derive_request_identity", "Digest covering algorithm, parameters, reference, inputs, and schema."),
      field("parameter_digest", "string", "derive_parameter_digest", "Digest of the declared derive parameters."),
      field("reference_digest", "string", "derive_reference_digest", "Digest of the exact PDB reference version."),
      field("input_digests", "json", "derive_input_digests", "Ordered digests of committed Core or registered asset inputs."),
    ],
  });
}

export function buildProteinStructureInterfaceDerivedTable(): TableDefinition {
  const schema = buildProteinStructureInterfaceDerivedSchema();
  return parseTableDefinition({
    table_id: "derived_interfaces",
    schema_ref: schema.schema_id,
    role: "derived",
    required: true,
    allow_empty: false,
    primary_key: [...schema.primary_key],
    field_names: schema.fields.map((item) => item.name),
  });
}

export function proteinStructureDerivedEvidenceProfile(): ValidationProfile {
  return parseValidationProfile({
    profile_id: PROTEIN_STRUCTURE_DERIVED_PROFILE_ID,
    dataset_family: PROTEIN_STRUCTURE_FAMILY_ID,
    acceptance: {
      minimum_valid_rows: 1,
      allow_empty_primary_dataset: false,
      allow_partial_publish: false,
    },
    description: "Require non-empty PDB interface records with closed deterministic derive provenance.",
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

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be positive`);
  }
  return value;
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
): ProteinStructureInterfaceDerivedRecord {
  const record = assertRecord(value, "protein structure derived record");
  assertExactKeys(record, RECORD_KEYS, "protein structure derived record");
  if (record.evidence_origin !== "deterministic_derive") {
    throw new TypeError("protein structure derived record must keep deterministic_derive origin");
  }
  const inputDigests = stringArray(record.input_digests, "derived record input_digests");
  const expectedInputs = receipt.provenance.inputs.map((input) => input.digest);
  if (JSON.stringify(inputDigests) !== JSON.stringify(expectedInputs)) {
    throw new TypeError("protein structure derived record input digests do not match provenance");
  }
  const requestIdentityDigest = assertSha256(record.request_identity_digest, "derived record request identity digest");
  if (requestIdentityDigest !== receipt.request_identity_digest) {
    throw new TypeError("protein structure derived record request identity digest does not match receipt");
  }
  if (assertSha256(record.parameter_digest, "derived record parameter digest") !== parameterDigest) {
    throw new TypeError("protein structure derived record parameter digest does not match parameters");
  }
  if (assertSha256(record.reference_digest, "derived record reference digest") !== receipt.provenance.reference.digest) {
    throw new TypeError("protein structure derived record reference digest does not match provenance");
  }
  return {
    interface_record_id: assertNonEmptyString(record.interface_record_id, "interface_record_id"),
    structure_id: assertNonEmptyString(record.structure_id, "structure_id"),
    structure_version: assertNonEmptyString(record.structure_version, "structure_version"),
    chain_a: assertNonEmptyString(record.chain_a, "chain_a"),
    residue_a: assertNonEmptyString(record.residue_a, "residue_a"),
    atom_a: assertNonEmptyString(record.atom_a, "atom_a"),
    chain_b: assertNonEmptyString(record.chain_b, "chain_b"),
    residue_b: assertNonEmptyString(record.residue_b, "residue_b"),
    atom_b: assertNonEmptyString(record.atom_b, "atom_b"),
    distance_angstrom: positiveNumber(record.distance_angstrom, "distance_angstrom"),
    cutoff_angstrom: positiveNumber(record.cutoff_angstrom, "cutoff_angstrom"),
    evidence_origin: "deterministic_derive",
    request_identity_digest: requestIdentityDigest,
    parameter_digest: parameterDigest,
    reference_digest: receipt.provenance.reference.digest,
    input_digests: inputDigests,
  };
}

export function consumeProteinStructureDerivedEvidence(
  value: DeterministicDeriveResultReceipt,
): ProteinStructureDerivedEvidence {
  const receipt = parseDeterministicDeriveResultReceipt(value);
  if (receipt.provenance.algorithm_id !== PDB_INTERFACE_DISTANCE_ALGORITHM_ID) {
    throw new TypeError("protein structure derived evidence requires the PDB interface distance algorithm");
  }
  if (receipt.output_schema_ref !== PROTEIN_STRUCTURE_INTERFACE_SCHEMA_ID) {
    throw new TypeError("protein structure derived evidence uses an unknown output schema");
  }
  const summary = assertJsonRecord(receipt.output_summary, "protein structure derived output summary");
  assertExactKeys(summary, SUMMARY_KEYS, "protein structure derived output fields");
  if (summary.dataset_family !== PROTEIN_STRUCTURE_FAMILY_ID || summary.evidence_origin !== "deterministic_derive") {
    throw new TypeError("protein structure derived output must retain its family and derived origin");
  }
  const parameterDigest = canonicalDigest(receipt.provenance.parameters);
  if (assertSha256(summary.parameter_digest, "derived summary parameter digest") !== parameterDigest) {
    throw new TypeError("protein structure derived summary parameter digest does not match provenance");
  }
  if (assertSha256(summary.reference_digest, "derived summary reference digest") !== receipt.provenance.reference.digest) {
    throw new TypeError("protein structure derived summary reference digest does not match provenance");
  }
  const inputDigests = stringArray(summary.input_digests, "derived summary input_digests");
  if (JSON.stringify(inputDigests) !== JSON.stringify(receipt.provenance.inputs.map((input) => input.digest))) {
    throw new TypeError("protein structure derived summary input digests do not match provenance");
  }
  const rowCount = positiveInteger(summary.row_count, "protein structure derived output row_count");
  if (!Array.isArray(summary.records) || summary.records.length !== rowCount) {
    throw new TypeError("protein structure derived output row_count does not match records");
  }
  if (canonicalDigest(summary) !== receipt.output_digest) {
    throw new TypeError("protein structure derived output digest does not match its records");
  }
  return {
    schema: buildProteinStructureInterfaceDerivedSchema(),
    table: buildProteinStructureInterfaceDerivedTable(),
    profile: proteinStructureDerivedEvidenceProfile(),
    records: summary.records.map((record) => parseRecord(record, receipt, parameterDigest)),
    parameterDigest,
  };
}
