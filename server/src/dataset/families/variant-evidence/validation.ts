import type { SourceLocatorV2 } from "@biomed/contracts";
import type {
  VariantAssertionConflictPolicy,
  VariantAssertionEvidenceInput,
  VariantEvidenceRecordInput,
  VariantEvidenceSchemaSet,
  VariantEvidenceSourceInput,
} from "./types.js";
import { VARIANT_ASSERTION_CONFLICT_POLICIES } from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

function fail(message: string): never {
  throw new TypeError(`variant evidence rejected: ${message}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value;
}

function safeId(value: unknown, name: string): string {
  const result = text(value, name);
  if (!SAFE_ID.test(result) || result.includes("..")) fail(`${name} is not a safe identifier`);
  return result;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyConflictEvidence(value: unknown): void {
  const conflict = record(value, "conflict_evidence");
  if (Object.keys(conflict).length === 0) fail("conflict_evidence must retain the conflicting claims");
}

function assertLocator(value: unknown, name: string): SourceLocatorV2 {
  const locator = record(value, name);
  if (locator.locator_version !== "2.0") fail(`${name} must use SourceLocator 2.0`);
  const kind = text(locator.locator_type, `${name}.locator_type`);
  if (!["json_pointer", "xml_cell", "pdf_region", "image_bbox"].includes(kind)) {
    fail(`${name}.locator_type is unsupported`);
  }
  safeId(locator.asset_id, `${name}.asset_id`);
  text(locator.logical_file, `${name}.logical_file`);
  text(locator.raw_value, `${name}.raw_value`);
  if (kind === "json_pointer") text(locator.json_pointer, `${name}.json_pointer`);
  if (kind === "xml_cell") {
    text(locator.xml_path, `${name}.xml_path`);
    safeId(locator.table_id, `${name}.table_id`);
    if (!Number.isSafeInteger(locator.row_index) || (locator.row_index as number) < 0) fail(`${name}.row_index is invalid`);
    if (!Number.isSafeInteger(locator.column_index) || (locator.column_index as number) < 0) fail(`${name}.column_index is invalid`);
  }
  if (kind === "pdf_region") {
    if (!Number.isSafeInteger(locator.page_number) || (locator.page_number as number) < 1) fail(`${name}.page_number is invalid`);
  }
  if (kind === "image_bbox") {
    const bbox = locator.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
      fail(`${name}.bbox is invalid`);
    }
  }
  return locator as unknown as SourceLocatorV2;
}

function assertPolicy(value: unknown): asserts value is VariantAssertionConflictPolicy {
  if (typeof value !== "string" || !VARIANT_ASSERTION_CONFLICT_POLICIES.includes(value as VariantAssertionConflictPolicy)) {
    fail("conflict_policy is not controlled");
  }
}

export function assertVariantAssertion(value: VariantAssertionEvidenceInput): void {
  safeId(value.assertion_id, "assertion_id");
  safeId(value.variant_id, "variant_id");
  text(value.variant_namespace, "variant_namespace");
  safeId(value.reference_sequence_id, "reference_sequence_id");
  text(value.reference_namespace, "reference_namespace");
  text(value.reference_version, "reference_version");
  text(value.reference_position, "reference_position");
  text(value.reference_allele, "reference_allele");
  text(value.alternate_allele, "alternate_allele");
  safeId(value.condition_id, "condition_id");
  text(value.condition_namespace, "condition_namespace");
  if (!["asserted", "refuted", "uncertain"].includes(value.assertion_status)) fail("assertion_status is not controlled");
  assertPolicy(value.conflict_policy);
  if (value.conflict_status === "conflict") {
    nonEmptyConflictEvidence(value.conflict_evidence);
    if (value.conflict_policy === "retain_conflict_and_block_primary") {
      fail("conflicted assertion is blocked from the primary table by conflict_policy");
    }
  } else if (value.conflict_status === "none") {
    if (value.conflict_evidence !== null) fail("non-conflicting assertions must not carry conflict_evidence");
  } else {
    fail("conflict_status is not controlled");
  }
  safeId(value.source_id, "source_id");
}

export function assertVariantEvidence(value: VariantEvidenceRecordInput): void {
  safeId(value.evidence_id, "evidence_id");
  safeId(value.assertion_id, "assertion_id");
  if (value.evidence_kind !== "source_assertion" && value.evidence_kind !== "derived_mapping") {
    fail("evidence_kind is not controlled");
  }
  text(value.evidence_text, "evidence_text");
  assertLocator(value.source_locator, "source_locator");
  if (!SHA256.test(value.evidence_digest)) fail("evidence_digest must be a SHA-256 digest");
  safeId(value.source_id, "source_id");
}

export function assertVariantEvidenceSource(value: VariantEvidenceSourceInput): void {
  safeId(value.source_id, "source_id");
  text(value.source_database, "source_database");
  if (!/^asset_[0-9a-f]{64}$/i.test(value.source_asset_id)) fail("source_asset_id must be content addressed");
  assertLocator(value.source_locator, "source_locator");
  if (value.source_locator.asset_id !== value.source_asset_id) fail("source locator asset does not match source_asset_id");
  text(value.retrieved_at, "retrieved_at");
  if (Number.isNaN(Date.parse(value.retrieved_at))) fail("retrieved_at must be an ISO datetime");
  text(value.carrier_type, "carrier_type");
}

export function assertVariantEvidenceRows(
  rows: {
    assertions: readonly VariantAssertionEvidenceInput[];
    evidence: readonly VariantEvidenceRecordInput[];
    sources: readonly VariantEvidenceSourceInput[];
  },
  schemas?: VariantEvidenceSchemaSet,
): void {
  if (schemas !== undefined && (schemas.variant.dataset_family !== "variant_evidence" || schemas.evidence.dataset_family !== "variant_evidence")) {
    fail("schema set belongs to another dataset family");
  }
  if (rows.assertions.length === 0) fail("primary variant assertion table must not be empty");
  if (rows.evidence.length === 0) fail("evidence table must not be empty");
  if (rows.sources.length === 0) fail("source table must not be empty");
  const assertions = new Map(rows.assertions.map((item) => [item.assertion_id, item]));
  const sources = new Map(rows.sources.map((item) => [item.source_id, item]));
  if (assertions.size !== rows.assertions.length) fail("duplicate assertion_id");
  if (sources.size !== rows.sources.length) fail("duplicate source_id");
  for (const assertion of rows.assertions) {
    assertVariantAssertion(assertion);
    if (!sources.has(assertion.source_id)) fail(`assertion ${assertion.assertion_id} references missing source_id`);
  }
  const evidenceIds = new Set<string>();
  for (const item of rows.evidence) {
    assertVariantEvidence(item);
    if (evidenceIds.has(item.evidence_id)) fail(`duplicate evidence_id ${item.evidence_id}`);
    evidenceIds.add(item.evidence_id);
    if (!assertions.has(item.assertion_id)) fail(`evidence ${item.evidence_id} references missing assertion_id`);
    const source = sources.get(item.source_id);
    if (source === undefined) fail(`evidence ${item.evidence_id} references missing source_id`);
    if (item.source_locator.asset_id !== source.source_asset_id) {
      fail(`evidence ${item.evidence_id} locator does not match its source asset`);
    }
  }
}
