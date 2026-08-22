import {
  assertArray,
  assertNumber,
  assertObject,
  assertString,
  parseProbeMappingAssertion,
  type ProbeMappingAssertion,
} from "@biomed/contracts";

import { validateAssetId, validateDatasetRevisionId } from "../identity/index.js";

const INPUT_KEYS = new Set([
  "dataset_revision_id",
  "mapping_scope_id",
  "platform_id",
  "source_probe_ids",
  "assertions",
  "policy_id",
  "expected_annotation_asset_receipt_refs",
]);
const ANNOTATION_RECEIPT_KEYS = new Set(["annotation_asset_id", "receipt_ref"]);
const CORE_POLICY_KEYS = new Set([
  "policy_id",
  "max_unmapped_ratio",
  "max_ambiguous_ratio",
  "max_invalid_ratio",
  "max_unresolved_ratio",
  "distinct_mapped_target_policy",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u;
const RECEIPT_REF = /^receipt:[A-Za-z0-9][A-Za-z0-9._:-]{0,247}$/u;
const MAX_ID_LENGTH = 256;
const MAX_REF_LENGTH = 1_024;

export type ProbeMappingDistinctMappedTargetPolicy = "require_ambiguous" | "reject";

/**
 * Policy data owned and selected by Dataset Core. It is not accepted from the
 * validation request. The standard validation API receives a trusted registry;
 * the pure fixture API names trusted policy injection explicitly.
 */
export interface CoreOwnedProbeMappingPolicy {
  policy_id: string;
  max_unmapped_ratio: number;
  max_ambiguous_ratio: number;
  max_invalid_ratio: number;
  max_unresolved_ratio: number;
  distinct_mapped_target_policy: ProbeMappingDistinctMappedTargetPolicy;
}

export interface ProbeMappingAnnotationAssetReceiptRef {
  annotation_asset_id: string;
  receipt_ref: string;
}

export interface ProbeMappingValidationInput {
  dataset_revision_id: string;
  mapping_scope_id: string;
  platform_id: string;
  source_probe_ids: readonly string[];
  assertions: readonly unknown[];
  policy_id: string;
  expected_annotation_asset_receipt_refs: readonly ProbeMappingAnnotationAssetReceiptRef[];
}

export type ProbeMappingCoverageStatus = ProbeMappingAssertion["mapping_status"] | "invalid";

export type ProbeMappingValidationIssueCode =
  | "input_contract_invalid"
  | "empty_source_probe_coverage"
  | "duplicate_source_probe"
  | "empty_annotation_asset_receipt_closure"
  | "duplicate_annotation_asset_receipt_ref"
  | "assertion_contract_invalid"
  | "mapping_target_invalid"
  | "dataset_revision_mismatch"
  | "mapping_scope_mismatch"
  | "platform_mismatch"
  | "unknown_source_probe"
  | "annotation_asset_mismatch"
  | "duplicate_assertion_id"
  | "assertion_id_conflict"
  | "missing_probe_evidence"
  | "conflicting_probe_status"
  | "distinct_mapped_targets_require_ambiguous"
  | "distinct_mapped_targets_rejected"
  | "unknown_policy_id"
  | "policy_id_mismatch"
  | "unmapped_ratio_exceeded"
  | "ambiguous_ratio_exceeded"
  | "invalid_probe_ratio_exceeded"
  | "unresolved_ratio_exceeded";

export type ProbeMappingCompositeKey = readonly [string, string, string, string];

export interface ProbeMappingValidationIssue {
  code: ProbeMappingValidationIssueCode;
  composite_key: ProbeMappingCompositeKey;
  mapping_assertion_id: string | null;
  detail: string;
}

export interface ProbeMappingProbeReport {
  composite_key: ProbeMappingCompositeKey;
  coverage_status: ProbeMappingCoverageStatus;
  mapping_assertion_ids: readonly string[];
}

export interface ProbeMappingCoverageSummary {
  source_probe_count: number;
  assertion_row_count: number;
  unique_assertion_id_count: number;
  valid_assertion_count: number;
  evidenced_probe_count: number;
  missing_evidence_probe_count: number;
  unknown_source_assertion_count: number;
  mapped_probe_count: number;
  unmapped_probe_count: number;
  ambiguous_probe_count: number;
  invalid_probe_count: number;
  mapped_ratio: number;
  unmapped_ratio: number;
  ambiguous_ratio: number;
  invalid_ratio: number;
  unresolved_ratio: number;
}

/**
 * Pure semantic validation output. This report is not an admission decision,
 * an OperationResult, a ProductAssessment, or a publication authority.
 */
export interface ProbeMappingValidationReport {
  report_kind: "probe_mapping_validation_report";
  schema_version: "1.0";
  passed: boolean;
  declared_closure: Readonly<{
    dataset_revision_id: string;
    mapping_scope_id: string;
    platform_id: string;
    annotation_asset_receipt_refs: readonly Readonly<ProbeMappingAnnotationAssetReceiptRef>[];
  }>;
  assertion_identity: Readonly<{
    primary_key: "mapping_assertion_id";
    identity_basis: "declared";
    formula_verified: false;
  }>;
  policy: Readonly<CoreOwnedProbeMappingPolicy> | null;
  annotation_asset_ids: readonly string[];
  mapping_rule_ids: readonly string[];
  target_namespaces: readonly string[];
  summary: Readonly<ProbeMappingCoverageSummary>;
  probes: readonly Readonly<ProbeMappingProbeReport>[];
  issues: readonly Readonly<ProbeMappingValidationIssue>[];
}

interface ParsedValidationInput extends ProbeMappingValidationInput {
  source_probe_ids: string[];
  assertions: unknown[];
  expected_annotation_asset_receipt_refs: ProbeMappingAnnotationAssetReceiptRef[];
}

interface ParsedAssertion {
  row: ProbeMappingAssertion;
  valid: boolean;
}

interface AssertionHints {
  mappingAssertionId: string | null;
  probeId: string | null;
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function tupleCompare(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = codePointCompare(left[index] ?? "", right[index] ?? "");
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(codePointCompare);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : "strict parser rejected the value";
}

function strictRecord(
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const object = assertObject(value, path);
  const unknownKeys = Object.keys(object)
    .filter((key) => !allowedKeys.has(key))
    .sort(codePointCompare);
  if (unknownKeys.length > 0) {
    throw new TypeError(`unknown fields at ${path}: ${unknownKeys.join(",")}`);
  }
  return object;
}

function ownValue(object: Record<string, unknown>, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`missing required own data property ${path}.${key}`);
  }
  return descriptor.value;
}

function canonicalWireString(value: unknown, path: string, maxLength: number): string {
  const string = assertString(value, path, true);
  if (string.length > maxLength || string.normalize("NFC") !== string) {
    throw new TypeError(`${path} must be bounded and NFC-normalized`);
  }
  const containsControlOrBidi = [...string].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x061c
      || codePoint === 0x200e
      || codePoint === 0x200f
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
  });
  if (containsControlOrBidi) {
    throw new TypeError(`${path} must not contain control characters`);
  }
  return string;
}

function safeId(value: unknown, path: string): string {
  const string = canonicalWireString(value, path, MAX_ID_LENGTH);
  if (!SAFE_ID.test(string)) throw new TypeError(`${path} must be a safe identifier`);
  return string;
}

function receiptRef(value: unknown, path: string): string {
  const string = canonicalWireString(value, path, MAX_REF_LENGTH);
  if (!RECEIPT_REF.test(string)) {
    throw new TypeError(`${path} must be an opaque receipt: registry reference`);
  }
  return string;
}

function finiteRatio(value: unknown, path: string): number {
  const number = assertNumber(value, path);
  if (number < 0 || number > 1) {
    throw new TypeError(`${path} must be a finite ratio in [0, 1]`);
  }
  return number;
}

function parseAnnotationReceiptRef(
  value: unknown,
  path: string,
): ProbeMappingAnnotationAssetReceiptRef {
  const object = strictRecord(value, path, ANNOTATION_RECEIPT_KEYS);
  const annotationAssetId = assertString(
    ownValue(object, "annotation_asset_id", path),
    `${path}.annotation_asset_id`,
  );
  validateAssetId(annotationAssetId);
  return {
    annotation_asset_id: annotationAssetId,
    receipt_ref: receiptRef(ownValue(object, "receipt_ref", path), `${path}.receipt_ref`),
  };
}

function parseCoreOwnedPolicy(value: unknown, path: string): CoreOwnedProbeMappingPolicy {
  const object = strictRecord(value, path, CORE_POLICY_KEYS);
  const distinctPolicy = ownValue(object, "distinct_mapped_target_policy", path);
  if (distinctPolicy !== "require_ambiguous" && distinctPolicy !== "reject") {
    throw new TypeError(
      `${path}.distinct_mapped_target_policy must be require_ambiguous or reject`,
    );
  }
  return {
    policy_id: safeId(ownValue(object, "policy_id", path), `${path}.policy_id`),
    max_unmapped_ratio: finiteRatio(
      ownValue(object, "max_unmapped_ratio", path),
      `${path}.max_unmapped_ratio`,
    ),
    max_ambiguous_ratio: finiteRatio(
      ownValue(object, "max_ambiguous_ratio", path),
      `${path}.max_ambiguous_ratio`,
    ),
    max_invalid_ratio: finiteRatio(
      ownValue(object, "max_invalid_ratio", path),
      `${path}.max_invalid_ratio`,
    ),
    max_unresolved_ratio: finiteRatio(
      ownValue(object, "max_unresolved_ratio", path),
      `${path}.max_unresolved_ratio`,
    ),
    distinct_mapped_target_policy: distinctPolicy,
  };
}

/**
 * Registry constructed from Core-owned configuration. Strict parsing happens
 * before storage. Freezing the parsed copy only prevents later mutation; it is
 * not used as a trust test.
 */
export class TrustedProbeMappingCorePolicyRegistry {
  readonly #policies = new Map<string, Readonly<CoreOwnedProbeMappingPolicy>>();

  constructor(trustedCorePolicies: readonly unknown[]) {
    const policies = assertArray(
      trustedCorePolicies,
      "$trusted_probe_mapping_core_policies",
      (value) => parseCoreOwnedPolicy(value, "$trusted_probe_mapping_core_policy"),
    );
    for (const policy of policies) {
      if (this.#policies.has(policy.policy_id)) {
        throw new TypeError(`duplicate trusted probe-mapping policy ID: ${policy.policy_id}`);
      }
      this.#policies.set(policy.policy_id, Object.freeze({ ...policy }));
    }
  }

  resolve(policyId: string): Readonly<CoreOwnedProbeMappingPolicy> | null {
    return this.#policies.get(policyId) ?? null;
  }

  policyIds(): readonly string[] {
    return [...this.#policies.keys()].sort(codePointCompare);
  }
}

function parseValidationInput(value: unknown): ParsedValidationInput {
  const path = "$probe_mapping_validation_input";
  const object = strictRecord(value, path, INPUT_KEYS);
  const datasetRevisionId = assertString(
    ownValue(object, "dataset_revision_id", path),
    `${path}.dataset_revision_id`,
  );
  validateDatasetRevisionId(datasetRevisionId);
  return {
    dataset_revision_id: datasetRevisionId,
    mapping_scope_id: safeId(
      ownValue(object, "mapping_scope_id", path),
      `${path}.mapping_scope_id`,
    ),
    platform_id: safeId(ownValue(object, "platform_id", path), `${path}.platform_id`),
    source_probe_ids: assertArray(
      ownValue(object, "source_probe_ids", path),
      `${path}.source_probe_ids`,
      (item) => safeId(item, `${path}.source_probe_ids[]`),
    ),
    assertions: assertArray(
      ownValue(object, "assertions", path),
      `${path}.assertions`,
      (item) => item,
    ),
    policy_id: safeId(ownValue(object, "policy_id", path), `${path}.policy_id`),
    expected_annotation_asset_receipt_refs: assertArray(
      ownValue(object, "expected_annotation_asset_receipt_refs", path),
      `${path}.expected_annotation_asset_receipt_refs`,
      (item) => parseAnnotationReceiptRef(
        item,
        `${path}.expected_annotation_asset_receipt_refs[]`,
      ),
    ),
  };
}

function compositeKey(
  datasetRevisionId: string,
  mappingScopeId: string,
  platformId: string,
  probeId: string,
): ProbeMappingCompositeKey {
  return [datasetRevisionId, mappingScopeId, platformId, probeId];
}

function rowKey(row: ProbeMappingAssertion): ProbeMappingCompositeKey {
  return compositeKey(
    row.dataset_revision_id,
    row.mapping_scope_id,
    row.platform_id,
    row.probe_id,
  );
}

function addIssue(
  issues: ProbeMappingValidationIssue[],
  code: ProbeMappingValidationIssueCode,
  key: ProbeMappingCompositeKey,
  mappingAssertionId: string | null,
  detail: string,
): void {
  issues.push({ code, composite_key: key, mapping_assertion_id: mappingAssertionId, detail });
}

function issueSortKey(value: ProbeMappingValidationIssue): readonly string[] {
  return [
    ...value.composite_key,
    value.code,
    value.mapping_assertion_id ?? "",
    value.detail,
  ];
}

function assertionFactTuple(row: ProbeMappingAssertion): readonly string[] {
  return [
    row.mapping_assertion_id,
    row.dataset_revision_id,
    row.mapping_scope_id,
    row.platform_id,
    row.probe_id,
    row.target_gene_id ?? "\u0000",
    row.target_namespace ?? "\u0000",
    row.annotation_asset_id,
    row.mapping_rule_id,
    row.mapping_status,
  ];
}

function sameAssertionFact(left: ProbeMappingAssertion, right: ProbeMappingAssertion): boolean {
  const leftTuple = assertionFactTuple(left);
  const rightTuple = assertionFactTuple(right);
  return leftTuple.every((value, index) => value === rightTuple[index]);
}

function hasValidTargetShape(row: ProbeMappingAssertion): boolean {
  const bothNull = row.target_gene_id === null && row.target_namespace === null;
  const bothPresent = row.target_gene_id !== null && row.target_namespace !== null;
  if (row.mapping_status === "mapped") return bothPresent;
  if (row.mapping_status === "unmapped") return bothNull;
  return bothNull || bothPresent;
}

function assertionHints(value: unknown): AssertionHints {
  try {
    const object = assertObject(value, "$probe_mapping_assertion_hint");
    const idValue = Object.getOwnPropertyDescriptor(object, "mapping_assertion_id")?.value;
    const probeValue = Object.getOwnPropertyDescriptor(object, "probe_id")?.value;
    return {
      mappingAssertionId: safeIdOrNull(idValue),
      probeId: safeIdOrNull(probeValue),
    };
  } catch {
    return { mappingAssertionId: null, probeId: null };
  }
}

function safeIdOrNull(value: unknown): string | null {
  try {
    return safeId(value, "$declared_id_hint");
  } catch {
    return null;
  }
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function zeroSummary(assertionRowCount = 0): ProbeMappingCoverageSummary {
  return {
    source_probe_count: 0,
    assertion_row_count: assertionRowCount,
    unique_assertion_id_count: 0,
    valid_assertion_count: 0,
    evidenced_probe_count: 0,
    missing_evidence_probe_count: 0,
    unknown_source_assertion_count: 0,
    mapped_probe_count: 0,
    unmapped_probe_count: 0,
    ambiguous_probe_count: 0,
    invalid_probe_count: 0,
    mapped_ratio: 0,
    unmapped_ratio: 0,
    ambiguous_ratio: 0,
    invalid_ratio: 0,
    unresolved_ratio: 0,
  };
}

function invalidInputReport(
  detail: string,
  policy: Readonly<CoreOwnedProbeMappingPolicy> | null,
): ProbeMappingValidationReport {
  return {
    report_kind: "probe_mapping_validation_report",
    schema_version: "1.0",
    passed: false,
    declared_closure: {
      dataset_revision_id: "",
      mapping_scope_id: "",
      platform_id: "",
      annotation_asset_receipt_refs: [],
    },
    assertion_identity: {
      primary_key: "mapping_assertion_id",
      identity_basis: "declared",
      formula_verified: false,
    },
    policy,
    annotation_asset_ids: [],
    mapping_rule_ids: [],
    target_namespaces: [],
    summary: zeroSummary(),
    probes: [],
    issues: [{
      code: "input_contract_invalid",
      composite_key: ["", "", "", ""],
      mapping_assertion_id: null,
      detail,
    }],
  };
}

function normalizeAnnotationReceiptClosure(
  input: ParsedValidationInput,
  issues: ProbeMappingValidationIssue[],
  declaredKey: ProbeMappingCompositeKey,
): ProbeMappingAnnotationAssetReceiptRef[] {
  const groups = new Map<string, ProbeMappingAnnotationAssetReceiptRef[]>();
  for (const receipt of input.expected_annotation_asset_receipt_refs) {
    const group = groups.get(receipt.annotation_asset_id) ?? [];
    group.push(receipt);
    groups.set(receipt.annotation_asset_id, group);
  }
  if (groups.size === 0) {
    addIssue(
      issues,
      "empty_annotation_asset_receipt_closure",
      declaredKey,
      null,
      "an annotation asset receipt closure is required",
    );
  }

  const normalized: ProbeMappingAnnotationAssetReceiptRef[] = [];
  for (const [assetId, group] of groups) {
    group.sort((left, right) => codePointCompare(left.receipt_ref, right.receipt_ref));
    const first = group[0]!;
    normalized.push(first);
    if (group.length > 1) {
      addIssue(
        issues,
        "duplicate_annotation_asset_receipt_ref",
        declaredKey,
        null,
        `annotation asset ${assetId} has repeated receipt declarations`,
      );
    }
  }
  normalized.sort((left, right) => tupleCompare(
    [left.annotation_asset_id, left.receipt_ref],
    [right.annotation_asset_id, right.receipt_ref],
  ));
  return normalized;
}

function validateParsedInput(
  input: ParsedValidationInput,
  policy: Readonly<CoreOwnedProbeMappingPolicy> | null,
  initialIssues: readonly ProbeMappingValidationIssue[] = [],
): ProbeMappingValidationReport {
  const issues = [...initialIssues];
  const declaredKey = compositeKey(
    input.dataset_revision_id,
    input.mapping_scope_id,
    input.platform_id,
    "",
  );
  const receiptClosure = normalizeAnnotationReceiptClosure(input, issues, declaredKey);
  const expectedAssetIds = new Set(receiptClosure.map((receipt) => receipt.annotation_asset_id));

  const sourceProbeIds: string[] = [];
  const sourceProbeSet = new Set<string>();
  for (const probeId of input.source_probe_ids) {
    if (sourceProbeSet.has(probeId)) {
      addIssue(
        issues,
        "duplicate_source_probe",
        compositeKey(
          input.dataset_revision_id,
          input.mapping_scope_id,
          input.platform_id,
          probeId,
        ),
        null,
        "source probe coverage must contain distinct probe IDs",
      );
      continue;
    }
    sourceProbeSet.add(probeId);
    sourceProbeIds.push(probeId);
  }
  sourceProbeIds.sort(codePointCompare);
  if (sourceProbeIds.length === 0) {
    addIssue(
      issues,
      "empty_source_probe_coverage",
      declaredKey,
      null,
      "source probe coverage must not be empty",
    );
  }

  const parsed: ParsedAssertion[] = [];
  const invalidProbeIds = new Set<string>();
  const observedSourceProbeIds = new Set<string>();
  let unknownSourceAssertionCount = 0;

  for (const candidate of input.assertions) {
    let row: ProbeMappingAssertion;
    try {
      // This is the contracts-owned descriptor-safe parser. Normal, unfrozen
      // plain objects are accepted; accessors and proxies are rejected without
      // reading their properties.
      row = parseProbeMappingAssertion(candidate, "$ProbeMappingAssertion");
    } catch (error) {
      const hints = assertionHints(candidate);
      if (hints.probeId !== null) {
        if (sourceProbeSet.has(hints.probeId)) {
          observedSourceProbeIds.add(hints.probeId);
          invalidProbeIds.add(hints.probeId);
        } else {
          unknownSourceAssertionCount += 1;
        }
      }
      addIssue(
        issues,
        "assertion_contract_invalid",
        compositeKey(
          input.dataset_revision_id,
          input.mapping_scope_id,
          input.platform_id,
          hints.probeId ?? "",
        ),
        hints.mappingAssertionId,
        errorDetail(error),
      );
      continue;
    }

    if (sourceProbeSet.has(row.probe_id)) observedSourceProbeIds.add(row.probe_id);
    let valid = true;
    const markInvalid = (code: ProbeMappingValidationIssueCode, detail: string): void => {
      valid = false;
      if (sourceProbeSet.has(row.probe_id)) invalidProbeIds.add(row.probe_id);
      addIssue(issues, code, rowKey(row), row.mapping_assertion_id, detail);
    };

    if (!hasValidTargetShape(row)) {
      markInvalid(
        "mapping_target_invalid",
        "mapped requires a target ID and namespace; unmapped requires null targets; ambiguous requires either a complete candidate pair or null targets",
      );
    }
    if (row.dataset_revision_id !== input.dataset_revision_id) {
      markInvalid(
        "dataset_revision_mismatch",
        `assertion revision ${row.dataset_revision_id} is outside declared revision ${input.dataset_revision_id}`,
      );
    }
    if (row.mapping_scope_id !== input.mapping_scope_id) {
      markInvalid(
        "mapping_scope_mismatch",
        `assertion scope ${row.mapping_scope_id} is outside declared scope ${input.mapping_scope_id}`,
      );
    }
    if (row.platform_id !== input.platform_id) {
      markInvalid(
        "platform_mismatch",
        `assertion platform ${row.platform_id} is outside declared platform ${input.platform_id}`,
      );
    }
    if (!sourceProbeSet.has(row.probe_id)) {
      unknownSourceAssertionCount += 1;
      markInvalid(
        "unknown_source_probe",
        `assertion probe ${row.probe_id} is absent from declared source probe coverage`,
      );
    }
    if (!expectedAssetIds.has(row.annotation_asset_id)) {
      markInvalid(
        "annotation_asset_mismatch",
        `assertion annotation asset ${row.annotation_asset_id} has no expected receipt reference`,
      );
    }
    parsed.push({ row, valid });
  }

  const assertionsById = new Map<string, ParsedAssertion[]>();
  for (const entry of parsed) {
    const group = assertionsById.get(entry.row.mapping_assertion_id) ?? [];
    group.push(entry);
    assertionsById.set(entry.row.mapping_assertion_id, group);
  }
  for (const [assertionId, group] of assertionsById) {
    if (group.length < 2) continue;
    group.sort((left, right) => tupleCompare(
      assertionFactTuple(left.row),
      assertionFactTuple(right.row),
    ));
    const baseline = group[0]!.row;
    const conflicting = group.some((entry) => !sameAssertionFact(baseline, entry.row));
    addIssue(
      issues,
      conflicting ? "assertion_id_conflict" : "duplicate_assertion_id",
      rowKey(baseline),
      assertionId,
      conflicting
        ? "one declared mapping_assertion_id identifies different assertion facts"
        : "mapping_assertion_id is a declared unique primary key and must not repeat",
    );
    for (const entry of group) {
      entry.valid = false;
      if (sourceProbeSet.has(entry.row.probe_id)) invalidProbeIds.add(entry.row.probe_id);
    }
  }

  const validEntries = parsed.filter((entry) => entry.valid);
  const entriesByProbe = new Map<string, ParsedAssertion[]>();
  for (const entry of validEntries) {
    if (!sourceProbeSet.has(entry.row.probe_id)) continue;
    const entries = entriesByProbe.get(entry.row.probe_id) ?? [];
    entries.push(entry);
    entriesByProbe.set(entry.row.probe_id, entries);
  }

  const probes: ProbeMappingProbeReport[] = [];
  let missingEvidenceProbeCount = 0;
  for (const probeId of sourceProbeIds) {
    const key = compositeKey(
      input.dataset_revision_id,
      input.mapping_scope_id,
      input.platform_id,
      probeId,
    );
    const entries = entriesByProbe.get(probeId) ?? [];
    const assertionIds = sortedUnique(entries.map((entry) => entry.row.mapping_assertion_id));
    let coverageStatus: ProbeMappingCoverageStatus;

    if (!observedSourceProbeIds.has(probeId)) {
      coverageStatus = "invalid";
      missingEvidenceProbeCount += 1;
      addIssue(
        issues,
        "missing_probe_evidence",
        key,
        null,
        "source probe has no mapping assertion; absence is not unmapped evidence",
      );
    } else if (invalidProbeIds.has(probeId) || entries.length === 0) {
      coverageStatus = "invalid";
    } else {
      const statuses = sortedUnique(entries.map((entry) => entry.row.mapping_status));
      if (statuses.length !== 1) {
        coverageStatus = "invalid";
        addIssue(
          issues,
          "conflicting_probe_status",
          key,
          null,
          `source probe has conflicting mapping statuses: ${statuses.join(",")}`,
        );
      } else if (statuses[0] === "mapped") {
        const distinctTargets = sortedUnique(entries.map((entry) =>
          `${entry.row.target_namespace}\u0000${entry.row.target_gene_id}`,
        ));
        if (distinctTargets.length > 1) {
          coverageStatus = "invalid";
          const reject = policy?.distinct_mapped_target_policy === "reject";
          addIssue(
            issues,
            reject
              ? "distinct_mapped_targets_rejected"
              : "distinct_mapped_targets_require_ambiguous",
            key,
            null,
            reject
              ? "Core policy rejects multiple distinct mapped targets for one source probe"
              : "multiple distinct candidate targets require ambiguous assertions",
          );
        } else {
          coverageStatus = "mapped";
        }
      } else {
        coverageStatus = statuses[0] as "unmapped" | "ambiguous";
      }
    }
    probes.push({
      composite_key: key,
      coverage_status: coverageStatus,
      mapping_assertion_ids: assertionIds,
    });
  }

  const sourceProbeCount = probes.length;
  const mappedProbeCount = probes.filter((probe) => probe.coverage_status === "mapped").length;
  const unmappedProbeCount = probes.filter((probe) => probe.coverage_status === "unmapped").length;
  const ambiguousProbeCount = probes.filter(
    (probe) => probe.coverage_status === "ambiguous",
  ).length;
  const invalidProbeCount = probes.filter((probe) => probe.coverage_status === "invalid").length;
  const mappedRatio = ratio(mappedProbeCount, sourceProbeCount);
  const unmappedRatio = ratio(unmappedProbeCount, sourceProbeCount);
  const ambiguousRatio = ratio(ambiguousProbeCount, sourceProbeCount);
  const invalidRatio = ratio(invalidProbeCount, sourceProbeCount);
  const unresolvedRatio = ratio(
    unmappedProbeCount + ambiguousProbeCount + invalidProbeCount,
    sourceProbeCount,
  );

  if (policy !== null) {
    for (const [computed, maximum, code, label] of [
      [unmappedRatio, policy.max_unmapped_ratio, "unmapped_ratio_exceeded", "unmapped"],
      [ambiguousRatio, policy.max_ambiguous_ratio, "ambiguous_ratio_exceeded", "ambiguous"],
      [invalidRatio, policy.max_invalid_ratio, "invalid_probe_ratio_exceeded", "invalid"],
      [unresolvedRatio, policy.max_unresolved_ratio, "unresolved_ratio_exceeded", "unresolved"],
    ] as const) {
      if (computed > maximum) {
        addIssue(
          issues,
          code,
          declaredKey,
          null,
          `computed ${label} ratio ${computed} exceeds trusted policy limit ${maximum}`,
        );
      }
    }
  }

  probes.sort((left, right) => tupleCompare(left.composite_key, right.composite_key));
  issues.sort((left, right) => tupleCompare(issueSortKey(left), issueSortKey(right)));

  return {
    report_kind: "probe_mapping_validation_report",
    schema_version: "1.0",
    passed: issues.length === 0,
    declared_closure: {
      dataset_revision_id: input.dataset_revision_id,
      mapping_scope_id: input.mapping_scope_id,
      platform_id: input.platform_id,
      annotation_asset_receipt_refs: receiptClosure,
    },
    assertion_identity: {
      primary_key: "mapping_assertion_id",
      identity_basis: "declared",
      formula_verified: false,
    },
    policy,
    annotation_asset_ids: sortedUnique(validEntries.map((entry) => entry.row.annotation_asset_id)),
    mapping_rule_ids: sortedUnique(validEntries.map((entry) => entry.row.mapping_rule_id)),
    target_namespaces: sortedUnique(validEntries.flatMap((entry) =>
      entry.row.target_namespace === null ? [] : [entry.row.target_namespace],
    )),
    summary: {
      source_probe_count: sourceProbeCount,
      assertion_row_count: input.assertions.length,
      unique_assertion_id_count: assertionsById.size,
      valid_assertion_count: validEntries.length,
      evidenced_probe_count: observedSourceProbeIds.size,
      missing_evidence_probe_count: missingEvidenceProbeCount,
      unknown_source_assertion_count: unknownSourceAssertionCount,
      mapped_probe_count: mappedProbeCount,
      unmapped_probe_count: unmappedProbeCount,
      ambiguous_probe_count: ambiguousProbeCount,
      invalid_probe_count: invalidProbeCount,
      mapped_ratio: mappedRatio,
      unmapped_ratio: unmappedRatio,
      ambiguous_ratio: ambiguousRatio,
      invalid_ratio: invalidRatio,
      unresolved_ratio: unresolvedRatio,
    },
    probes,
    issues,
  };
}

/**
 * Standard pure-module API: the request selects only a policy ID. The actual
 * policy values come from a registry previously constructed by trusted Core
 * configuration.
 */
export function validateProbeMappingAssertions(
  rawInput: unknown,
  trustedPolicyRegistry: TrustedProbeMappingCorePolicyRegistry,
): ProbeMappingValidationReport {
  if (!(trustedPolicyRegistry instanceof TrustedProbeMappingCorePolicyRegistry)) {
    throw new TypeError("a TrustedProbeMappingCorePolicyRegistry is required");
  }
  let input: ParsedValidationInput;
  try {
    input = parseValidationInput(rawInput);
  } catch (error) {
    return invalidInputReport(errorDetail(error), null);
  }
  const policy = trustedPolicyRegistry.resolve(input.policy_id);
  const initialIssues: ProbeMappingValidationIssue[] = [];
  if (policy === null) {
    addIssue(
      initialIssues,
      "unknown_policy_id",
      compositeKey(input.dataset_revision_id, input.mapping_scope_id, input.platform_id, ""),
      null,
      `probe-mapping policy ${input.policy_id} is not registered`,
    );
  }
  return validateParsedInput(input, policy, initialIssues);
}

/**
 * Explicit trusted-injection entry point for isolated pure fixtures. Production
 * callers should use validateProbeMappingAssertions with a trusted registry.
 */
export function validateProbeMappingAssertionsWithTrustedCorePolicy(
  rawInput: unknown,
  trustedCorePolicy: unknown,
): ProbeMappingValidationReport {
  const policy = Object.freeze(parseCoreOwnedPolicy(
    trustedCorePolicy,
    "$trusted_probe_mapping_core_policy",
  ));
  let input: ParsedValidationInput;
  try {
    input = parseValidationInput(rawInput);
  } catch (error) {
    return invalidInputReport(errorDetail(error), policy);
  }
  const initialIssues: ProbeMappingValidationIssue[] = [];
  if (input.policy_id !== policy.policy_id) {
    addIssue(
      initialIssues,
      "policy_id_mismatch",
      compositeKey(input.dataset_revision_id, input.mapping_scope_id, input.platform_id, ""),
      null,
      `request selected policy ${input.policy_id}, but trusted injection supplied ${policy.policy_id}`,
    );
  }
  return validateParsedInput(input, policy, initialIssues);
}
