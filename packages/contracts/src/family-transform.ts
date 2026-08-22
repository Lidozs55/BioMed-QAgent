/**
 * Family Host + Transform Host wire contracts.
 *
 * Parsers are exact-key, own-data-property parsers. They do not execute
 * accessors, accept exotic prototypes, or infer one wire version from another.
 * Raw JSON duplicate-key rejection belongs at the raw JSON decoder boundary;
 * these object parsers reject only collisions that remain observable after NFC
 * normalization.
 */

import type { JsonValue } from "./json.js";
import type {
  RelationCardinality,
  RelationDefinition,
  RelationMissingPolicy,
  TableDefinition,
  TableRole,
} from "./dataset-multitable.js";
import { APIError } from "./runtime/errors.js";
import {
  assertArray,
  assertBoolean,
  assertCanonicalJsonValue,
  assertHex64,
  assertJsonRecord,
  assertNonNegativeInt,
  assertNumber,
  assertObject,
  assertString,
} from "./runtime/primitives.js";

/* ------------------------------------------------------------------ */
/* Enums / shared vocabulary                                           */
/* ------------------------------------------------------------------ */

export type TransformScope = "example" | "task" | "user" | "curated" | "system";

export type TransformTrustStatus =
  | "submitted"
  | "sandbox_executable"
  | "fixture_verified"
  | "shadow_verified"
  | "trusted_e2e_verified"
  | "activated"
  | "revoked"
  | "retired";

export type DeterminismProfile = "deterministic" | "non_deterministic";

export type TerminalReason =
  | "succeeded"
  | "compile_rejected"
  | "admission_rejected"
  | "failed"
  | "cancelled"
  | "timeout"
  | "oom"
  | "quota_exceeded"
  | "policy_violation"
  | "sandbox_unavailable";

export type CancellationState = "none" | "requested" | "acknowledged" | "terminated";

export type SandboxBackend =
  | "unavailable"
  | "container"
  | "linux_namespace"
  | "windows_job_object";

const TRANSFORM_SCOPES: readonly TransformScope[] = [
  "example",
  "task",
  "user",
  "curated",
  "system",
];
const DETERMINISM_PROFILES: readonly DeterminismProfile[] = ["deterministic", "non_deterministic"];
const TERMINAL_REASONS: readonly TerminalReason[] = [
  "succeeded",
  "compile_rejected",
  "admission_rejected",
  "failed",
  "cancelled",
  "timeout",
  "oom",
  "quota_exceeded",
  "policy_violation",
  "sandbox_unavailable",
];
const CANCELLATION_STATES: readonly CancellationState[] = [
  "none",
  "requested",
  "acknowledged",
  "terminated",
];
const SANDBOX_BACKENDS: readonly SandboxBackend[] = [
  "unavailable",
  "container",
  "linux_namespace",
  "windows_job_object",
];
const MAPPING_STATUSES = ["mapped", "unmapped", "ambiguous"] as const;

const MAX_ID_LENGTH = 256;
const MAX_REF_LENGTH = 1_024;
const MAX_TEXT_LENGTH = 4_096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+\-]*\/[a-z0-9][a-z0-9!#$&^_.+\-]*$/u;
const DATASET_ID = /^ds_([0-9a-f]{64})$/u;
const DATASET_REVISION_ID = /^dsrev_([0-9a-f]{64})$/u;
const ASSET_ID = /^asset_([0-9a-f]{64})$/u;
const BUNDLE_REF = /^bundle_[0-9a-f]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

/* ------------------------------------------------------------------ */
/* Strict descriptor-based helpers                                    */
/* ------------------------------------------------------------------ */

function strictObject(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  const object = assertObject(value, path);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new APIError(502, `Unknown field "${key}" at ${path}`);
    }
  }
  return object;
}

function ownValue(object: Record<string, unknown>, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new APIError(502, `Missing required own data property "${key}" at ${path}`);
  }
  return descriptor.value;
}

function assertWellFormedUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new APIError(502, `Expected well-formed Unicode at ${path}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new APIError(502, `Expected well-formed Unicode at ${path}`);
    }
  }
}

function assertNfc(value: string, path: string): string {
  assertWellFormedUnicode(value, path);
  if (value !== value.normalize("NFC")) {
    throw new APIError(502, `Expected NFC-normalized string at ${path}`);
  }
  return value;
}

function assertNoWireControls(value: string, path: string): void {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new APIError(502, `Control characters are not accepted at ${path}`);
  }
  if (BIDI_CONTROLS.test(value)) {
    throw new APIError(502, `Bidirectional control characters are not accepted at ${path}`);
  }
}

function assertNoTraversal(value: string, path: string): void {
  const segments = value.split(/[\\/]/u);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new APIError(502, `Path traversal is not accepted at ${path}`);
  }
  if (/%(?:2e|2f|5c)/iu.test(value)) {
    throw new APIError(502, `Encoded path traversal is not accepted at ${path}`);
  }
}

function assertBoundedText(value: unknown, path: string, maxLength = MAX_TEXT_LENGTH): string {
  const string = assertString(value, path, true);
  if (string.length > maxLength) {
    throw new APIError(502, `String at ${path} exceeds ${maxLength} characters`);
  }
  assertNfc(string, path);
  assertNoWireControls(string, path);
  return string;
}

function assertSafeId(value: unknown, path: string): string {
  const string = assertBoundedText(value, path, MAX_ID_LENGTH);
  if (!SAFE_ID.test(string)) {
    throw new APIError(502, `Expected safe identifier at ${path}`);
  }
  assertNoTraversal(string, path);
  return string;
}

function assertSafeRef(value: unknown, path: string): string {
  const string = assertBoundedText(value, path, MAX_REF_LENGTH);
  if (!SAFE_REF.test(string)) {
    throw new APIError(502, `Expected safe reference at ${path}`);
  }
  assertNoTraversal(string, path);
  return string;
}

function assertNullableSafeRef(value: unknown, path: string): string | null {
  if (value === null) return null;
  return assertSafeRef(value, path);
}

function assertNullableSafeId(value: unknown, path: string): string | null {
  if (value === null) return null;
  return assertSafeId(value, path);
}

function assertMediaType(value: unknown, path: string): string {
  const string = assertBoundedText(value, path, 256);
  if (!MEDIA_TYPE.test(string)) {
    throw new APIError(502, `Expected normalized media type at ${path}`);
  }
  return string;
}

function assertEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  label: string,
): T {
  const string = assertString(value, path);
  const found = allowed.find((candidate) => candidate === string);
  if (!found) {
    throw new APIError(502, `Invalid ${label} "${string}" at ${path}`);
  }
  return found;
}

function getSafeId(object: Record<string, unknown>, key: string, path: string): string {
  return assertSafeId(ownValue(object, key, path), `${path}.${key}`);
}

function getSafeRef(object: Record<string, unknown>, key: string, path: string): string {
  return assertSafeRef(ownValue(object, key, path), `${path}.${key}`);
}

function getBoundedText(object: Record<string, unknown>, key: string, path: string): string {
  return assertBoundedText(ownValue(object, key, path), `${path}.${key}`);
}

function getArray<T>(
  object: Record<string, unknown>,
  key: string,
  path: string,
  item: (value: unknown, index: number) => T,
): T[] {
  return assertArray(ownValue(object, key, path), `${path}.${key}`, item);
}

function getSafeIdArray(object: Record<string, unknown>, key: string, path: string): string[] {
  return getArray(object, key, path, (value, index) =>
    assertSafeId(value, `${path}.${key}[${index}]`),
  );
}

function assertScope(value: unknown, path: string): TransformScope {
  return assertEnum(value, path, TRANSFORM_SCOPES, "TransformScope");
}

function assertDatasetId(value: unknown, path: string): string {
  const string = assertBoundedText(value, path, 67);
  if (!DATASET_ID.test(string)) {
    throw new APIError(502, `Expected ds_<64 lowercase hex> dataset_id at ${path}`);
  }
  return string;
}

function assertDatasetRevisionId(value: unknown, path: string): string {
  const string = assertBoundedText(value, path, 70);
  if (!DATASET_REVISION_ID.test(string)) {
    throw new APIError(502, `Expected dsrev_<64 lowercase hex> dataset_revision_id at ${path}`);
  }
  return string;
}

function assertAssetId(value: unknown, path: string): string {
  const string = assertBoundedText(value, path, 70);
  if (!ASSET_ID.test(string)) {
    throw new APIError(502, `Expected asset_<64 lowercase hex> asset_id at ${path}`);
  }
  return string;
}

function assertIsoUtc(value: unknown, path: string): string {
  const string = assertBoundedText(value, path, 24);
  if (!ISO_UTC.test(string)) {
    throw new APIError(502, `Expected strict UTC ISO timestamp at ${path}`);
  }
  const epoch = Date.parse(string);
  if (!Number.isFinite(epoch)) {
    throw new APIError(502, `Expected valid UTC ISO timestamp at ${path}`);
  }
  const roundTrip = new Date(epoch).toISOString();
  const canonical = roundTrip.endsWith(".000Z") ? roundTrip.replace(".000Z", "Z") : roundTrip;
  if (string !== roundTrip && string !== canonical) {
    throw new APIError(502, `Expected round-trip UTC ISO timestamp at ${path}`);
  }
  return string;
}

function assertNullableIsoUtc(value: unknown, path: string): string | null {
  if (value === null) return null;
  return assertIsoUtc(value, path);
}

function assertSafeInteger(value: unknown, path: string): number {
  const number = assertNumber(value, path);
  if (!Number.isSafeInteger(number)) {
    throw new APIError(502, `Expected safe integer at ${path}, got ${number}`);
  }
  return number;
}

function assertNullableSafeInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  return assertSafeInteger(value, path);
}

/* ------------------------------------------------------------------ */
/* Identity / projection / relation / audit                            */
/* ------------------------------------------------------------------ */

export interface IdentityContract {
  dataset_id_scheme: "ds_hash";
  dataset_revision_id_scheme: "dsrev_hash";
  asset_id_scheme: "asset_sha256";
  sample_identity_fields: string[];
  probe_mapping_assertion_pk: string;
}

export interface DatasetIdentity {
  dataset_id: string;
  dataset_revision_id: string;
  asset_id: string;
}

export interface SampleIdentity {
  dataset_revision_id: string;
  sample_id: string;
}

export interface ProbeMappingAssertion {
  mapping_assertion_id: string;
  dataset_revision_id: string;
  mapping_scope_id: string;
  platform_id: string;
  probe_id: string;
  target_gene_id: string | null;
  target_namespace: string | null;
  annotation_asset_id: string;
  mapping_rule_id: string;
  mapping_status: "mapped" | "unmapped" | "ambiguous";
}

export interface AuditArtifactDefinition {
  artifact_id: string;
  schema_ref: string;
  fields: string[];
  locator_ref: string;
  receipt_ref: string;
  append_only: true;
}

export interface Projection {
  projection_id: string;
  schema_version: "2.0";
  primary_tables: string[];
  supporting_tables: string[];
  derived_tables: string[];
  required: string[];
  optional: string[];
  allow_empty: string[];
  relations: string[];
  row_granularity: string;
  compatibility_dimensions: string[];
  merge_identity_fields: string[];
  validation_policy_ref: string;
  assessment_policy_ref: string;
}

const IDENTITY_KEYS = new Set([
  "dataset_id_scheme",
  "dataset_revision_id_scheme",
  "asset_id_scheme",
  "sample_identity_fields",
  "probe_mapping_assertion_pk",
]);
const DATASET_IDENTITY_KEYS = new Set(["dataset_id", "dataset_revision_id", "asset_id"]);
const SAMPLE_IDENTITY_KEYS = new Set(["dataset_revision_id", "sample_id"]);
const PROBE_KEYS = new Set([
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
]);
const AUDIT_KEYS = new Set([
  "artifact_id",
  "schema_ref",
  "fields",
  "locator_ref",
  "receipt_ref",
  "append_only",
]);
const PROJECTION_KEYS = new Set([
  "projection_id",
  "schema_version",
  "primary_tables",
  "supporting_tables",
  "derived_tables",
  "required",
  "optional",
  "allow_empty",
  "relations",
  "row_granularity",
  "compatibility_dimensions",
  "merge_identity_fields",
  "validation_policy_ref",
  "assessment_policy_ref",
]);

export function parseIdentityContract(value: unknown, path: string): IdentityContract {
  const object = strictObject(value, path, IDENTITY_KEYS);
  const datasetScheme = ownValue(object, "dataset_id_scheme", path);
  const revisionScheme = ownValue(object, "dataset_revision_id_scheme", path);
  const assetScheme = ownValue(object, "asset_id_scheme", path);
  if (datasetScheme !== "ds_hash") {
    throw new APIError(502, `dataset_id_scheme must equal "ds_hash" at ${path}`);
  }
  if (revisionScheme !== "dsrev_hash") {
    throw new APIError(502, `dataset_revision_id_scheme must equal "dsrev_hash" at ${path}`);
  }
  if (assetScheme !== "asset_sha256") {
    throw new APIError(502, `asset_id_scheme must equal "asset_sha256" at ${path}`);
  }
  return {
    dataset_id_scheme: "ds_hash",
    dataset_revision_id_scheme: "dsrev_hash",
    asset_id_scheme: "asset_sha256",
    sample_identity_fields: getSafeIdArray(object, "sample_identity_fields", path),
    probe_mapping_assertion_pk: getSafeId(object, "probe_mapping_assertion_pk", path),
  };
}

export function parseDatasetIdentity(value: unknown, path: string): DatasetIdentity {
  const object = strictObject(value, path, DATASET_IDENTITY_KEYS);
  return {
    dataset_id: assertDatasetId(ownValue(object, "dataset_id", path), `${path}.dataset_id`),
    dataset_revision_id: assertDatasetRevisionId(
      ownValue(object, "dataset_revision_id", path),
      `${path}.dataset_revision_id`,
    ),
    asset_id: assertAssetId(ownValue(object, "asset_id", path), `${path}.asset_id`),
  };
}

export function parseSampleIdentity(value: unknown, path: string): SampleIdentity {
  const object = strictObject(value, path, SAMPLE_IDENTITY_KEYS);
  return {
    dataset_revision_id: assertDatasetRevisionId(
      ownValue(object, "dataset_revision_id", path),
      `${path}.dataset_revision_id`,
    ),
    sample_id: getSafeId(object, "sample_id", path),
  };
}

export function parseProbeMappingAssertion(value: unknown, path: string): ProbeMappingAssertion {
  const object = strictObject(value, path, PROBE_KEYS);
  return {
    mapping_assertion_id: getSafeId(object, "mapping_assertion_id", path),
    dataset_revision_id: assertDatasetRevisionId(
      ownValue(object, "dataset_revision_id", path),
      `${path}.dataset_revision_id`,
    ),
    mapping_scope_id: getSafeId(object, "mapping_scope_id", path),
    platform_id: getSafeId(object, "platform_id", path),
    probe_id: getSafeId(object, "probe_id", path),
    target_gene_id: assertNullableSafeId(
      ownValue(object, "target_gene_id", path),
      `${path}.target_gene_id`,
    ),
    target_namespace: assertNullableSafeId(
      ownValue(object, "target_namespace", path),
      `${path}.target_namespace`,
    ),
    annotation_asset_id: assertAssetId(
      ownValue(object, "annotation_asset_id", path),
      `${path}.annotation_asset_id`,
    ),
    mapping_rule_id: getSafeId(object, "mapping_rule_id", path),
    mapping_status: assertEnum(
      ownValue(object, "mapping_status", path),
      `${path}.mapping_status`,
      MAPPING_STATUSES,
      "mapping_status",
    ),
  };
}

export function parseAuditArtifactDefinition(value: unknown, path: string): AuditArtifactDefinition {
  const object = strictObject(value, path, AUDIT_KEYS);
  const appendOnly = assertBoolean(ownValue(object, "append_only", path), `${path}.append_only`);
  if (!appendOnly) {
    throw new APIError(502, `AuditArtifactDefinition.append_only must be true at ${path}`);
  }
  return {
    artifact_id: getSafeId(object, "artifact_id", path),
    schema_ref: getSafeRef(object, "schema_ref", path),
    fields: getSafeIdArray(object, "fields", path),
    locator_ref: getSafeRef(object, "locator_ref", path),
    receipt_ref: getSafeRef(object, "receipt_ref", path),
    append_only: true,
  };
}

export function parseProjection(value: unknown, path: string): Projection {
  const object = strictObject(value, path, PROJECTION_KEYS);
  if (ownValue(object, "schema_version", path) !== "2.0") {
    throw new APIError(502, `Projection.schema_version must be "2.0" at ${path}`);
  }
  return {
    projection_id: getSafeId(object, "projection_id", path),
    schema_version: "2.0",
    primary_tables: getSafeIdArray(object, "primary_tables", path),
    supporting_tables: getSafeIdArray(object, "supporting_tables", path),
    derived_tables: getSafeIdArray(object, "derived_tables", path),
    required: getSafeIdArray(object, "required", path),
    optional: getSafeIdArray(object, "optional", path),
    allow_empty: getSafeIdArray(object, "allow_empty", path),
    relations: getSafeIdArray(object, "relations", path),
    row_granularity: getSafeId(object, "row_granularity", path),
    compatibility_dimensions: getSafeIdArray(object, "compatibility_dimensions", path),
    merge_identity_fields: getSafeIdArray(object, "merge_identity_fields", path),
    validation_policy_ref: getSafeRef(object, "validation_policy_ref", path),
    assessment_policy_ref: getSafeRef(object, "assessment_policy_ref", path),
  };
}

/* ------------------------------------------------------------------ */
/* Scope refs, FamilySpec, DatasetTransform, execution receipt         */
/* ------------------------------------------------------------------ */

export interface ScopeQualifiedRef {
  scope: TransformScope;
  id: string;
  version: string;
  digest: string;
}

export interface DeclaredInputRole {
  role: string;
  media_type: string;
  constraint_ref: string | null;
}

export interface DeclaredTableRef {
  table_id: string;
  schema_ref: string;
}

export interface FamilySpec {
  family_spec_id: string;
  semantic_version: string;
  canonical_digest: string;
  projections: Projection[];
  table_definitions: TableDefinition[];
  relations: RelationDefinition[];
  identity: IdentityContract;
  transform_capability_refs: string[];
  declared_outputs: DeclaredTableRef[];
  integration_policy_ref: string;
  validation_policy_ref: string;
  assessment_policy_ref: string;
  resource_class_request: string;
  scope: TransformScope;
  author: string;
  evidence_refs: string[];
}

/** Canonical digest body; excludes the self-referential canonical_digest. */
export type FamilySpecDigestBody = Omit<FamilySpec, "canonical_digest">;

export interface DatasetTransform {
  transform_id: string;
  version: string;
  source_digest: string;
  bundle_digest: string;
  compiler_id: string;
  compiler_version: string;
  compiler_options_digest: string;
  runtime_abi_version: string;
  runtime_policy_version: string;
  dependency_closure_digest: string;
  code_bundle_ref: string;
  entrypoint: string;
  declared_input_roles: DeclaredInputRole[];
  declared_output_tables: DeclaredTableRef[];
  bound_family_spec_digest: string;
  bound_projection_digest: string;
  determinism_profile: DeterminismProfile;
  resource_class: string;
  origin: string;
  scope: TransformScope;
  review_refs: string[];
}

export interface InputAssetReceipt {
  asset_id: string;
  role: string;
  sha256: string;
  size_bytes: number;
  locator_ref: string;
}

export interface InputResultReceipt {
  result_manifest_id: string;
  role: string;
  sha256: string;
  size_bytes: number;
  locator_ref: string;
}

export interface OutputReceipt {
  table_id: string;
  schema_ref: string;
  artifact_ref: string;
  locator_ref: string;
  sha256: string;
  size_bytes: number;
  row_count: number;
}

export interface ResourceLimits {
  wall_ms: number;
  cpu_ms: number;
  rss_bytes: number;
  temp_bytes: number;
  output_bytes: number;
  log_bytes: number;
  open_files: number;
  pids: number;
}

export interface TransformExecutionReceipt {
  schema_version: "1.0";
  task_id: string;
  run_id: string;
  build_id: string;
  invocation_id: string;
  attempt: number;
  generation: number;
  request_digest: string;
  parameters_digest: string;
  family_spec_digest: string;
  projection_digest: string;
  transform_digest: string;
  bundle_digest: string;
  compiler_digest: string;
  runtime_digest: string;
  policy_digest: string;
  input_asset_receipts: InputAssetReceipt[];
  input_result_receipts: InputResultReceipt[];
  granted_capabilities: string[];
  resource_limits: ResourceLimits;
  sandbox_backend: SandboxBackend;
  sandbox_config_digest: string;
  exit_state: TerminalReason;
  exit_code: number | null;
  exit_signal: string | null;
  wall_ms: number;
  cpu_ms: number;
  rss_bytes: number;
  temp_bytes: number;
  output_bytes: number;
  log_bytes: number;
  quarantined_output_receipts: OutputReceipt[];
  stdout_ref: string;
  stderr_ref: string;
  audit_refs: string[];
  cancellation_state: CancellationState;
  cancel_requested_at: string | null;
  deadline_at: string;
  started_at: string;
  finished_at: string;
  host_implementation_digest: string;
  host_issued_at: string;
}

const SCOPE_REF_KEYS = new Set(["scope", "id", "version", "digest"]);
const DECLARED_INPUT_ROLE_KEYS = new Set(["role", "media_type", "constraint_ref"]);
const DECLARED_TABLE_REF_KEYS = new Set(["table_id", "schema_ref"]);
const FAMILY_KEYS = new Set([
  "family_spec_id",
  "semantic_version",
  "canonical_digest",
  "projections",
  "table_definitions",
  "relations",
  "identity",
  "transform_capability_refs",
  "declared_outputs",
  "integration_policy_ref",
  "validation_policy_ref",
  "assessment_policy_ref",
  "resource_class_request",
  "scope",
  "author",
  "evidence_refs",
]);
const TRANSFORM_KEYS = new Set([
  "transform_id",
  "version",
  "source_digest",
  "bundle_digest",
  "compiler_id",
  "compiler_version",
  "compiler_options_digest",
  "runtime_abi_version",
  "runtime_policy_version",
  "dependency_closure_digest",
  "code_bundle_ref",
  "entrypoint",
  "declared_input_roles",
  "declared_output_tables",
  "bound_family_spec_digest",
  "bound_projection_digest",
  "determinism_profile",
  "resource_class",
  "origin",
  "scope",
  "review_refs",
]);
const RECEIPT_KEYS = new Set([
  "schema_version",
  "task_id",
  "run_id",
  "build_id",
  "invocation_id",
  "attempt",
  "generation",
  "request_digest",
  "parameters_digest",
  "family_spec_digest",
  "projection_digest",
  "transform_digest",
  "bundle_digest",
  "compiler_digest",
  "runtime_digest",
  "policy_digest",
  "input_asset_receipts",
  "input_result_receipts",
  "granted_capabilities",
  "resource_limits",
  "sandbox_backend",
  "sandbox_config_digest",
  "exit_state",
  "exit_code",
  "exit_signal",
  "wall_ms",
  "cpu_ms",
  "rss_bytes",
  "temp_bytes",
  "output_bytes",
  "log_bytes",
  "quarantined_output_receipts",
  "stdout_ref",
  "stderr_ref",
  "audit_refs",
  "cancellation_state",
  "cancel_requested_at",
  "deadline_at",
  "started_at",
  "finished_at",
  "host_implementation_digest",
  "host_issued_at",
]);

export function parseScopeQualifiedRef(value: unknown, path: string): ScopeQualifiedRef {
  const object = strictObject(value, path, SCOPE_REF_KEYS);
  return {
    scope: assertScope(ownValue(object, "scope", path), `${path}.scope`),
    id: getSafeId(object, "id", path),
    version: getSafeId(object, "version", path),
    digest: assertHex64(ownValue(object, "digest", path), `${path}.digest`),
  };
}

function parseDeclaredInputRole(value: unknown, path: string): DeclaredInputRole {
  const object = strictObject(value, path, DECLARED_INPUT_ROLE_KEYS);
  return {
    role: getSafeId(object, "role", path),
    media_type: assertMediaType(ownValue(object, "media_type", path), `${path}.media_type`),
    constraint_ref: assertNullableSafeRef(
      ownValue(object, "constraint_ref", path),
      `${path}.constraint_ref`,
    ),
  };
}

function parseDeclaredTableRef(value: unknown, path: string): DeclaredTableRef {
  const object = strictObject(value, path, DECLARED_TABLE_REF_KEYS);
  return {
    table_id: getSafeId(object, "table_id", path),
    schema_ref: getSafeRef(object, "schema_ref", path),
  };
}

const TABLE_DEFINITION_KEYS = new Set([
  "table_id",
  "schema_ref",
  "role",
  "required",
  "allow_empty",
  "primary_key",
  "field_names",
]);
const RELATION_DEFINITION_KEYS = new Set([
  "relation_id",
  "from_table_id",
  "from_fields",
  "to_table_id",
  "to_fields",
  "cardinality",
  "missing_policy",
]);
const TABLE_ROLES = ["primary", "supporting", "derived"] as const;
const RELATION_CARDINALITIES = [
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
] as const;
const RELATION_MISSING_POLICIES = [
  "reject",
  "allow_empty",
  "allow_missing",
  "profile_defined",
] as const;

function parseTableDefinition(value: unknown, path: string): TableDefinition {
  const object = strictObject(value, path, TABLE_DEFINITION_KEYS);
  return {
    table_id: getSafeId(object, "table_id", path),
    schema_ref: getSafeRef(object, "schema_ref", path),
    role: assertEnum(ownValue(object, "role", path), `${path}.role`, TABLE_ROLES, "TableRole") as TableRole,
    required: assertBoolean(ownValue(object, "required", path), `${path}.required`),
    allow_empty: assertBoolean(ownValue(object, "allow_empty", path), `${path}.allow_empty`),
    primary_key: getSafeIdArray(object, "primary_key", path),
    field_names: getSafeIdArray(object, "field_names", path),
  };
}

function parseRelationDefinition(value: unknown, path: string): RelationDefinition {
  const object = strictObject(value, path, RELATION_DEFINITION_KEYS);
  return {
    relation_id: getSafeId(object, "relation_id", path),
    from_table_id: getSafeId(object, "from_table_id", path),
    from_fields: getSafeIdArray(object, "from_fields", path),
    to_table_id: getSafeId(object, "to_table_id", path),
    to_fields: getSafeIdArray(object, "to_fields", path),
    cardinality: assertEnum(
      ownValue(object, "cardinality", path),
      `${path}.cardinality`,
      RELATION_CARDINALITIES,
      "cardinality",
    ) as RelationCardinality,
    missing_policy: assertEnum(
      ownValue(object, "missing_policy", path),
      `${path}.missing_policy`,
      RELATION_MISSING_POLICIES,
      "missing_policy",
    ) as RelationMissingPolicy,
  };
}

export function parseFamilySpec(value: unknown, path: string): FamilySpec {
  const object = strictObject(value, path, FAMILY_KEYS);
  return {
    family_spec_id: getSafeId(object, "family_spec_id", path),
    semantic_version: getSafeId(object, "semantic_version", path),
    canonical_digest: assertHex64(ownValue(object, "canonical_digest", path), `${path}.canonical_digest`),
    projections: getArray(object, "projections", path, (item, index) =>
      parseProjection(item, `${path}.projections[${index}]`),
    ),
    table_definitions: getArray(object, "table_definitions", path, (item, index) =>
      parseTableDefinition(item, `${path}.table_definitions[${index}]`),
    ),
    relations: getArray(object, "relations", path, (item, index) =>
      parseRelationDefinition(item, `${path}.relations[${index}]`),
    ),
    identity: parseIdentityContract(ownValue(object, "identity", path), `${path}.identity`),
    transform_capability_refs: getArray(object, "transform_capability_refs", path, (item, index) =>
      assertSafeRef(item, `${path}.transform_capability_refs[${index}]`),
    ),
    declared_outputs: getArray(object, "declared_outputs", path, (item, index) =>
      parseDeclaredTableRef(item, `${path}.declared_outputs[${index}]`),
    ),
    integration_policy_ref: getSafeRef(object, "integration_policy_ref", path),
    validation_policy_ref: getSafeRef(object, "validation_policy_ref", path),
    assessment_policy_ref: getSafeRef(object, "assessment_policy_ref", path),
    resource_class_request: getSafeId(object, "resource_class_request", path),
    scope: assertScope(ownValue(object, "scope", path), `${path}.scope`),
    author: getBoundedText(object, "author", path),
    evidence_refs: getArray(object, "evidence_refs", path, (item, index) =>
      assertSafeRef(item, `${path}.evidence_refs[${index}]`),
    ),
  };
}

export function familySpecDigestBody(spec: FamilySpec): FamilySpecDigestBody {
  const parsed = parseFamilySpec(spec, "$family_spec");
  return {
    family_spec_id: parsed.family_spec_id,
    semantic_version: parsed.semantic_version,
    projections: parsed.projections,
    table_definitions: parsed.table_definitions,
    relations: parsed.relations,
    identity: parsed.identity,
    transform_capability_refs: parsed.transform_capability_refs,
    declared_outputs: parsed.declared_outputs,
    integration_policy_ref: parsed.integration_policy_ref,
    validation_policy_ref: parsed.validation_policy_ref,
    assessment_policy_ref: parsed.assessment_policy_ref,
    resource_class_request: parsed.resource_class_request,
    scope: parsed.scope,
    author: parsed.author,
    evidence_refs: parsed.evidence_refs,
  };
}

export function parseDatasetTransform(value: unknown, path: string): DatasetTransform {
  const object = strictObject(value, path, TRANSFORM_KEYS);
  const bundleDigest = assertHex64(
    ownValue(object, "bundle_digest", path),
    `${path}.bundle_digest`,
  );
  const codeBundleRef = assertSafeRef(ownValue(object, "code_bundle_ref", path), `${path}.code_bundle_ref`);
  if (!BUNDLE_REF.test(codeBundleRef) || codeBundleRef !== `bundle_${bundleDigest}`) {
    throw new APIError(
      502,
      `code_bundle_ref must equal bundle_<bundle_digest> at ${path}.code_bundle_ref`,
    );
  }
  return {
    transform_id: getSafeId(object, "transform_id", path),
    version: getSafeId(object, "version", path),
    source_digest: assertHex64(ownValue(object, "source_digest", path), `${path}.source_digest`),
    bundle_digest: bundleDigest,
    compiler_id: getSafeId(object, "compiler_id", path),
    compiler_version: getSafeId(object, "compiler_version", path),
    compiler_options_digest: assertHex64(
      ownValue(object, "compiler_options_digest", path),
      `${path}.compiler_options_digest`,
    ),
    runtime_abi_version: getSafeId(object, "runtime_abi_version", path),
    runtime_policy_version: getSafeId(object, "runtime_policy_version", path),
    dependency_closure_digest: assertHex64(
      ownValue(object, "dependency_closure_digest", path),
      `${path}.dependency_closure_digest`,
    ),
    code_bundle_ref: codeBundleRef,
    entrypoint: getSafeId(object, "entrypoint", path),
    declared_input_roles: getArray(object, "declared_input_roles", path, (item, index) =>
      parseDeclaredInputRole(item, `${path}.declared_input_roles[${index}]`),
    ),
    declared_output_tables: getArray(object, "declared_output_tables", path, (item, index) =>
      parseDeclaredTableRef(item, `${path}.declared_output_tables[${index}]`),
    ),
    bound_family_spec_digest: assertHex64(
      ownValue(object, "bound_family_spec_digest", path),
      `${path}.bound_family_spec_digest`,
    ),
    bound_projection_digest: assertHex64(
      ownValue(object, "bound_projection_digest", path),
      `${path}.bound_projection_digest`,
    ),
    determinism_profile: assertEnum(
      ownValue(object, "determinism_profile", path),
      `${path}.determinism_profile`,
      DETERMINISM_PROFILES,
      "determinism_profile",
    ),
    resource_class: getSafeId(object, "resource_class", path),
    origin: getSafeId(object, "origin", path),
    scope: assertScope(ownValue(object, "scope", path), `${path}.scope`),
    review_refs: getArray(object, "review_refs", path, (item, index) =>
      assertSafeRef(item, `${path}.review_refs[${index}]`),
    ),
  };
}

const INPUT_ASSET_RECEIPT_KEYS = new Set([
  "asset_id",
  "role",
  "sha256",
  "size_bytes",
  "locator_ref",
]);
const INPUT_RESULT_RECEIPT_KEYS = new Set([
  "result_manifest_id",
  "role",
  "sha256",
  "size_bytes",
  "locator_ref",
]);
const OUTPUT_RECEIPT_KEYS = new Set([
  "table_id",
  "schema_ref",
  "artifact_ref",
  "locator_ref",
  "sha256",
  "size_bytes",
  "row_count",
]);
const RESOURCE_LIMIT_KEYS = new Set([
  "wall_ms",
  "cpu_ms",
  "rss_bytes",
  "temp_bytes",
  "output_bytes",
  "log_bytes",
  "open_files",
  "pids",
]);

function parseInputAssetReceipt(value: unknown, path: string): InputAssetReceipt {
  const object = strictObject(value, path, INPUT_ASSET_RECEIPT_KEYS);
  const assetId = assertAssetId(ownValue(object, "asset_id", path), `${path}.asset_id`);
  const sha256 = assertHex64(ownValue(object, "sha256", path), `${path}.sha256`);
  if (assetId !== `asset_${sha256}`) {
    throw new APIError(502, `asset_id and sha256 must bind the same bytes at ${path}`);
  }
  return {
    asset_id: assetId,
    role: getSafeId(object, "role", path),
    sha256,
    size_bytes: assertNonNegativeInt(ownValue(object, "size_bytes", path), `${path}.size_bytes`),
    locator_ref: getSafeRef(object, "locator_ref", path),
  };
}

function parseInputResultReceipt(value: unknown, path: string): InputResultReceipt {
  const object = strictObject(value, path, INPUT_RESULT_RECEIPT_KEYS);
  return {
    result_manifest_id: getSafeId(object, "result_manifest_id", path),
    role: getSafeId(object, "role", path),
    sha256: assertHex64(ownValue(object, "sha256", path), `${path}.sha256`),
    size_bytes: assertNonNegativeInt(ownValue(object, "size_bytes", path), `${path}.size_bytes`),
    locator_ref: getSafeRef(object, "locator_ref", path),
  };
}

function parseOutputReceipt(value: unknown, path: string): OutputReceipt {
  const object = strictObject(value, path, OUTPUT_RECEIPT_KEYS);
  return {
    table_id: getSafeId(object, "table_id", path),
    schema_ref: getSafeRef(object, "schema_ref", path),
    artifact_ref: getSafeRef(object, "artifact_ref", path),
    locator_ref: getSafeRef(object, "locator_ref", path),
    sha256: assertHex64(ownValue(object, "sha256", path), `${path}.sha256`),
    size_bytes: assertNonNegativeInt(ownValue(object, "size_bytes", path), `${path}.size_bytes`),
    row_count: assertNonNegativeInt(ownValue(object, "row_count", path), `${path}.row_count`),
  };
}

function parseResourceLimits(value: unknown, path: string): ResourceLimits {
  const object = strictObject(value, path, RESOURCE_LIMIT_KEYS);
  return {
    wall_ms: assertNonNegativeInt(ownValue(object, "wall_ms", path), `${path}.wall_ms`),
    cpu_ms: assertNonNegativeInt(ownValue(object, "cpu_ms", path), `${path}.cpu_ms`),
    rss_bytes: assertNonNegativeInt(ownValue(object, "rss_bytes", path), `${path}.rss_bytes`),
    temp_bytes: assertNonNegativeInt(ownValue(object, "temp_bytes", path), `${path}.temp_bytes`),
    output_bytes: assertNonNegativeInt(ownValue(object, "output_bytes", path), `${path}.output_bytes`),
    log_bytes: assertNonNegativeInt(ownValue(object, "log_bytes", path), `${path}.log_bytes`),
    open_files: assertNonNegativeInt(ownValue(object, "open_files", path), `${path}.open_files`),
    pids: assertNonNegativeInt(ownValue(object, "pids", path), `${path}.pids`),
  };
}

export function parseTransformExecutionReceipt(value: unknown, path: string): TransformExecutionReceipt {
  const object = strictObject(value, path, RECEIPT_KEYS);
  if (ownValue(object, "schema_version", path) !== "1.0") {
    throw new APIError(502, `TransformExecutionReceipt.schema_version must be "1.0" at ${path}`);
  }
  const cancellationState = assertEnum(
    ownValue(object, "cancellation_state", path),
    `${path}.cancellation_state`,
    CANCELLATION_STATES,
    "cancellation_state",
  );
  const cancelRequestedAt = assertNullableIsoUtc(
    ownValue(object, "cancel_requested_at", path),
    `${path}.cancel_requested_at`,
  );
  if ((cancellationState === "none") !== (cancelRequestedAt === null)) {
    throw new APIError(
      502,
      `cancel_requested_at must be null only when cancellation_state is "none" at ${path}`,
    );
  }
  const startedAt = assertIsoUtc(ownValue(object, "started_at", path), `${path}.started_at`);
  const finishedAt = assertIsoUtc(ownValue(object, "finished_at", path), `${path}.finished_at`);
  const hostIssuedAt = assertIsoUtc(ownValue(object, "host_issued_at", path), `${path}.host_issued_at`);
  const deadlineAt = assertIsoUtc(ownValue(object, "deadline_at", path), `${path}.deadline_at`);
  if (
    Date.parse(startedAt) > Date.parse(finishedAt)
    || Date.parse(finishedAt) > Date.parse(hostIssuedAt)
    || Date.parse(startedAt) > Date.parse(deadlineAt)
  ) {
    throw new APIError(
      502,
      `Receipt timestamps must satisfy started_at <= finished_at <= host_issued_at and started_at <= deadline_at at ${path}`,
    );
  }
  if (
    cancelRequestedAt !== null
    && (
      Date.parse(cancelRequestedAt) < Date.parse(startedAt)
      || Date.parse(cancelRequestedAt) > Date.parse(finishedAt)
    )
  ) {
    throw new APIError(
      502,
      `cancel_requested_at must fall between started_at and finished_at at ${path}`,
    );
  }
  const sandboxBackend = assertEnum(
    ownValue(object, "sandbox_backend", path),
    `${path}.sandbox_backend`,
    SANDBOX_BACKENDS,
    "sandbox_backend",
  );
  const exitState = assertEnum(
    ownValue(object, "exit_state", path),
    `${path}.exit_state`,
    TERMINAL_REASONS,
    "exit_state",
  );
  if ((sandboxBackend === "unavailable") !== (exitState === "sandbox_unavailable")) {
    throw new APIError(
      502,
      `sandbox_backend "unavailable" and exit_state "sandbox_unavailable" must occur together at ${path}`,
    );
  }
  if (exitState === "cancelled" && cancellationState === "none") {
    throw new APIError(502, `cancelled receipt requires a cancellation state at ${path}`);
  }
  const exitCode = assertNullableSafeInteger(
    ownValue(object, "exit_code", path),
    `${path}.exit_code`,
  );
  const exitSignal = assertNullableSafeId(
    ownValue(object, "exit_signal", path),
    `${path}.exit_signal`,
  );
  if (exitState === "succeeded" && (exitCode !== 0 || exitSignal !== null)) {
    throw new APIError(502, `succeeded receipt requires exit_code=0 and no exit_signal at ${path}`);
  }
  if (exitState === "succeeded" && Date.parse(finishedAt) > Date.parse(deadlineAt)) {
    throw new APIError(502, `succeeded receipt must finish no later than deadline_at at ${path}`);
  }
  if (exitState === "sandbox_unavailable" && (exitCode !== null || exitSignal !== null)) {
    throw new APIError(502, `sandbox_unavailable receipt cannot report a worker exit at ${path}`);
  }
  const outputReceipts = getArray(
    object,
    "quarantined_output_receipts",
    path,
    (item, index) => parseOutputReceipt(item, `${path}.quarantined_output_receipts[${index}]`),
  );
  if (exitState === "sandbox_unavailable" && outputReceipts.length > 0) {
    throw new APIError(502, `sandbox_unavailable receipt cannot contain quarantine outputs at ${path}`);
  }
  const resourceLimits = parseResourceLimits(
    ownValue(object, "resource_limits", path),
    `${path}.resource_limits`,
  );
  const usage = {
    wall_ms: assertNonNegativeInt(ownValue(object, "wall_ms", path), `${path}.wall_ms`),
    cpu_ms: assertNonNegativeInt(ownValue(object, "cpu_ms", path), `${path}.cpu_ms`),
    rss_bytes: assertNonNegativeInt(ownValue(object, "rss_bytes", path), `${path}.rss_bytes`),
    temp_bytes: assertNonNegativeInt(ownValue(object, "temp_bytes", path), `${path}.temp_bytes`),
    output_bytes: assertNonNegativeInt(ownValue(object, "output_bytes", path), `${path}.output_bytes`),
    log_bytes: assertNonNegativeInt(ownValue(object, "log_bytes", path), `${path}.log_bytes`),
  };
  for (const [key, value] of Object.entries(usage)) {
    const limit = resourceLimits[key as keyof typeof usage];
    if (value > limit) {
      throw new APIError(502, `Receipt resource usage ${key} exceeds its granted limit at ${path}`);
    }
  }
  const receiptedOutputBytes = outputReceipts.reduce(
    (total, output) => total + BigInt(output.size_bytes),
    0n,
  );
  if (receiptedOutputBytes > BigInt(usage.output_bytes)) {
    throw new APIError(
      502,
      `quarantined output receipt sizes exceed output_bytes at ${path}`,
    );
  }

  return {
    schema_version: "1.0",
    task_id: getSafeId(object, "task_id", path),
    run_id: getSafeId(object, "run_id", path),
    build_id: getSafeId(object, "build_id", path),
    invocation_id: getSafeId(object, "invocation_id", path),
    attempt: assertNonNegativeInt(ownValue(object, "attempt", path), `${path}.attempt`),
    generation: assertNonNegativeInt(ownValue(object, "generation", path), `${path}.generation`),
    request_digest: assertHex64(ownValue(object, "request_digest", path), `${path}.request_digest`),
    parameters_digest: assertHex64(
      ownValue(object, "parameters_digest", path),
      `${path}.parameters_digest`,
    ),
    family_spec_digest: assertHex64(
      ownValue(object, "family_spec_digest", path),
      `${path}.family_spec_digest`,
    ),
    projection_digest: assertHex64(
      ownValue(object, "projection_digest", path),
      `${path}.projection_digest`,
    ),
    transform_digest: assertHex64(
      ownValue(object, "transform_digest", path),
      `${path}.transform_digest`,
    ),
    bundle_digest: assertHex64(ownValue(object, "bundle_digest", path), `${path}.bundle_digest`),
    compiler_digest: assertHex64(ownValue(object, "compiler_digest", path), `${path}.compiler_digest`),
    runtime_digest: assertHex64(ownValue(object, "runtime_digest", path), `${path}.runtime_digest`),
    policy_digest: assertHex64(ownValue(object, "policy_digest", path), `${path}.policy_digest`),
    input_asset_receipts: getArray(object, "input_asset_receipts", path, (item, index) =>
      parseInputAssetReceipt(item, `${path}.input_asset_receipts[${index}]`),
    ),
    input_result_receipts: getArray(object, "input_result_receipts", path, (item, index) =>
      parseInputResultReceipt(item, `${path}.input_result_receipts[${index}]`),
    ),
    granted_capabilities: getSafeIdArray(object, "granted_capabilities", path),
    resource_limits: resourceLimits,
    sandbox_backend: sandboxBackend,
    sandbox_config_digest: assertHex64(
      ownValue(object, "sandbox_config_digest", path),
      `${path}.sandbox_config_digest`,
    ),
    exit_state: exitState,
    exit_code: exitCode,
    exit_signal: exitSignal,
    ...usage,
    quarantined_output_receipts: outputReceipts,
    stdout_ref: getSafeRef(object, "stdout_ref", path),
    stderr_ref: getSafeRef(object, "stderr_ref", path),
    audit_refs: getArray(object, "audit_refs", path, (item, index) =>
      assertSafeRef(item, `${path}.audit_refs[${index}]`),
    ),
    cancellation_state: cancellationState,
    cancel_requested_at: cancelRequestedAt,
    deadline_at: deadlineAt,
    started_at: startedAt,
    finished_at: finishedAt,
    host_implementation_digest: assertHex64(
      ownValue(object, "host_implementation_digest", path),
      `${path}.host_implementation_digest`,
    ),
    host_issued_at: hostIssuedAt,
  };
}

/* ------------------------------------------------------------------ */
/* BuildSpec 2.0 proposal / resolved wire separation                   */
/* ------------------------------------------------------------------ */

interface DatasetBuildSpec2Base {
  schema_version: "2.0";
  build_id: string;
  family_spec_ref: ScopeQualifiedRef;
  projection_ref: string;
  transform_refs: ScopeQualifiedRef[];
  policy_refs: ScopeQualifiedRef[];
  output_format: string;
  idempotency_identity: string;
}

export interface DatasetBuildProposal2SourceBinding {
  binding_id: string;
  source: string;
  input_requirement_ref: string;
  parameters: Record<string, JsonValue>;
}

export interface ResolvedBuildSpec2SourceBinding {
  binding_id: string;
  source: string;
  registered_asset_ref: string | null;
  registered_result_ref: string | null;
  parameters: Record<string, JsonValue>;
}

/** Compatibility type name: BuildSpec2 is the resolved, Core-admissible shape. */
export type BuildSpec2SourceBinding = ResolvedBuildSpec2SourceBinding;

export interface DatasetBuildProposal2 extends DatasetBuildSpec2Base {
  spec_kind: "proposal";
  source_bindings: DatasetBuildProposal2SourceBinding[];
}

export interface ResolvedDatasetBuildSpec2 extends DatasetBuildSpec2Base {
  spec_kind: "resolved";
  source_bindings: ResolvedBuildSpec2SourceBinding[];
}

/**
 * Compatibility alias retained for callers that imported DatasetBuildSpec2.
 * It has resolved-only semantics; it is never a proposal union.
 */
export type DatasetBuildSpec2 = ResolvedDatasetBuildSpec2;

const BUILD2_KEYS = new Set([
  "schema_version",
  "spec_kind",
  "build_id",
  "family_spec_ref",
  "projection_ref",
  "source_bindings",
  "transform_refs",
  "policy_refs",
  "output_format",
  "idempotency_identity",
]);
const PROPOSAL_BINDING_KEYS = new Set([
  "binding_id",
  "source",
  "input_requirement_ref",
  "parameters",
]);
const RESOLVED_BINDING_KEYS = new Set([
  "binding_id",
  "source",
  "registered_asset_ref",
  "registered_result_ref",
  "parameters",
]);

function parseProposalBinding(value: unknown, path: string): DatasetBuildProposal2SourceBinding {
  const object = strictObject(value, path, PROPOSAL_BINDING_KEYS);
  return {
    binding_id: getSafeId(object, "binding_id", path),
    source: getSafeId(object, "source", path),
    input_requirement_ref: getSafeRef(object, "input_requirement_ref", path),
    parameters: assertJsonRecord(ownValue(object, "parameters", path), `${path}.parameters`),
  };
}

function parseResolvedBinding(value: unknown, path: string): ResolvedBuildSpec2SourceBinding {
  const object = strictObject(value, path, RESOLVED_BINDING_KEYS);
  const registeredAssetRef = assertNullableSafeRef(
    ownValue(object, "registered_asset_ref", path),
    `${path}.registered_asset_ref`,
  );
  const registeredResultRef = assertNullableSafeRef(
    ownValue(object, "registered_result_ref", path),
    `${path}.registered_result_ref`,
  );
  if ((registeredAssetRef === null) === (registeredResultRef === null)) {
    throw new APIError(
      502,
      `Resolved binding must contain exactly one registered asset or result handle at ${path}`,
    );
  }
  if (registeredAssetRef !== null && !ASSET_ID.test(registeredAssetRef)) {
    throw new APIError(502, `registered_asset_ref must be asset_<64 lowercase hex> at ${path}`);
  }
  return {
    binding_id: getSafeId(object, "binding_id", path),
    source: getSafeId(object, "source", path),
    registered_asset_ref: registeredAssetRef,
    registered_result_ref: registeredResultRef,
    parameters: assertJsonRecord(ownValue(object, "parameters", path), `${path}.parameters`),
  };
}

function parseBuild2Base(
  object: Record<string, unknown>,
  path: string,
): DatasetBuildSpec2Base {
  if (ownValue(object, "schema_version", path) !== "2.0") {
    throw new APIError(502, `DatasetBuildSpec2.schema_version must be "2.0" at ${path}`);
  }
  return {
    schema_version: "2.0",
    build_id: getSafeId(object, "build_id", path),
    family_spec_ref: parseScopeQualifiedRef(
      ownValue(object, "family_spec_ref", path),
      `${path}.family_spec_ref`,
    ),
    projection_ref: getSafeRef(object, "projection_ref", path),
    transform_refs: getArray(object, "transform_refs", path, (item, index) =>
      parseScopeQualifiedRef(item, `${path}.transform_refs[${index}]`),
    ),
    policy_refs: getArray(object, "policy_refs", path, (item, index) =>
      parseScopeQualifiedRef(item, `${path}.policy_refs[${index}]`),
    ),
    output_format: getSafeId(object, "output_format", path),
    idempotency_identity: getSafeId(object, "idempotency_identity", path),
  };
}

export function parseDatasetBuildProposal2(value: unknown, path: string): DatasetBuildProposal2 {
  const object = strictObject(value, path, BUILD2_KEYS);
  const base = parseBuild2Base(object, path);
  if (ownValue(object, "spec_kind", path) !== "proposal") {
    throw new APIError(502, `DatasetBuildProposal2.spec_kind must be "proposal" at ${path}`);
  }
  return {
    ...base,
    spec_kind: "proposal",
    source_bindings: getArray(object, "source_bindings", path, (item, index) =>
      parseProposalBinding(item, `${path}.source_bindings[${index}]`),
    ),
  };
}

export function parseResolvedDatasetBuildSpec2(
  value: unknown,
  path: string,
): ResolvedDatasetBuildSpec2 {
  const object = strictObject(value, path, BUILD2_KEYS);
  const base = parseBuild2Base(object, path);
  if (ownValue(object, "spec_kind", path) !== "resolved") {
    throw new APIError(502, `ResolvedDatasetBuildSpec2.spec_kind must be "resolved" at ${path}`);
  }
  return {
    ...base,
    spec_kind: "resolved",
    source_bindings: getArray(object, "source_bindings", path, (item, index) =>
      parseResolvedBinding(item, `${path}.source_bindings[${index}]`),
    ),
  };
}

/** Resolved-only compatibility parser. No version or shape sniffing fallback. */
export function parseDatasetBuildSpec2(value: unknown, path: string): DatasetBuildSpec2 {
  return parseResolvedDatasetBuildSpec2(value, path);
}

/* ------------------------------------------------------------------ */
/* Canonical implementation and transform-descriptor digest inputs    */
/* ------------------------------------------------------------------ */

export interface ImplementationDigestInput {
  normalized_source_sha256: string;
  emitted_bundle_sha256: string;
  compiler_id: string;
  compiler_version: string;
  compiler_options_digest: string;
  dependency_closure_digest: string;
  runtime_abi_version: string;
  host_policy_version: string;
}

export interface TransformDescriptorDigestInput {
  transform_id: string;
  version: string;
  entrypoint: string;
  implementation_digest: string;
  bound_family_spec_digest: string;
  bound_projection_digest: string;
  declared_input_roles: DeclaredInputRole[];
  declared_output_tables: DeclaredTableRef[];
  runtime_policy_digest: string;
  import_policy_digest: string;
  resource_policy_digest: string;
}

const IMPLEMENTATION_DIGEST_KEYS = new Set([
  "normalized_source_sha256",
  "emitted_bundle_sha256",
  "compiler_id",
  "compiler_version",
  "compiler_options_digest",
  "dependency_closure_digest",
  "runtime_abi_version",
  "host_policy_version",
]);
const TRANSFORM_DESCRIPTOR_DIGEST_KEYS = new Set([
  "transform_id",
  "version",
  "entrypoint",
  "implementation_digest",
  "bound_family_spec_digest",
  "bound_projection_digest",
  "declared_input_roles",
  "declared_output_tables",
  "runtime_policy_digest",
  "import_policy_digest",
  "resource_policy_digest",
]);

export function parseImplementationDigestInput(
  value: unknown,
  path: string,
): ImplementationDigestInput {
  const object = strictObject(value, path, IMPLEMENTATION_DIGEST_KEYS);
  return {
    normalized_source_sha256: assertHex64(
      ownValue(object, "normalized_source_sha256", path),
      `${path}.normalized_source_sha256`,
    ),
    emitted_bundle_sha256: assertHex64(
      ownValue(object, "emitted_bundle_sha256", path),
      `${path}.emitted_bundle_sha256`,
    ),
    compiler_id: getSafeId(object, "compiler_id", path),
    compiler_version: getSafeId(object, "compiler_version", path),
    compiler_options_digest: assertHex64(
      ownValue(object, "compiler_options_digest", path),
      `${path}.compiler_options_digest`,
    ),
    dependency_closure_digest: assertHex64(
      ownValue(object, "dependency_closure_digest", path),
      `${path}.dependency_closure_digest`,
    ),
    runtime_abi_version: getSafeId(object, "runtime_abi_version", path),
    host_policy_version: getSafeId(object, "host_policy_version", path),
  };
}

export function parseTransformDescriptorDigestInput(
  value: unknown,
  path: string,
): TransformDescriptorDigestInput {
  const object = strictObject(value, path, TRANSFORM_DESCRIPTOR_DIGEST_KEYS);
  return {
    transform_id: getSafeId(object, "transform_id", path),
    version: getSafeId(object, "version", path),
    entrypoint: getSafeId(object, "entrypoint", path),
    implementation_digest: assertHex64(
      ownValue(object, "implementation_digest", path),
      `${path}.implementation_digest`,
    ),
    bound_family_spec_digest: assertHex64(
      ownValue(object, "bound_family_spec_digest", path),
      `${path}.bound_family_spec_digest`,
    ),
    bound_projection_digest: assertHex64(
      ownValue(object, "bound_projection_digest", path),
      `${path}.bound_projection_digest`,
    ),
    declared_input_roles: getArray(object, "declared_input_roles", path, (item, index) =>
      parseDeclaredInputRole(item, `${path}.declared_input_roles[${index}]`),
    ),
    declared_output_tables: getArray(object, "declared_output_tables", path, (item, index) =>
      parseDeclaredTableRef(item, `${path}.declared_output_tables[${index}]`),
    ),
    runtime_policy_digest: assertHex64(
      ownValue(object, "runtime_policy_digest", path),
      `${path}.runtime_policy_digest`,
    ),
    import_policy_digest: assertHex64(
      ownValue(object, "import_policy_digest", path),
      `${path}.import_policy_digest`,
    ),
    resource_policy_digest: assertHex64(
      ownValue(object, "resource_policy_digest", path),
      `${path}.resource_policy_digest`,
    ),
  };
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new APIError(502, "Cannot canonicalize non-finite number");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new APIError(502, `Cannot canonicalize non-data property "${key}"`);
    }
    entries.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`);
  }
  return `{${entries.join(",")}}`;
}

/**
 * Deterministic, key-sorted, NFC-normalized JSON serialization.
 * Sparse arrays, non-finite numbers, accessors, exotic prototypes, proxies,
 * unsupported values, and normalized duplicate keys fail closed.
 */
export function stableStringify(value: unknown): string {
  return canonicalJson(assertCanonicalJsonValue(value, "$canonical"));
}

/** Build the frozen canonical byte string for the implementation digest. */
export function buildImplementationDigestCanonical(input: ImplementationDigestInput): string {
  return stableStringify(parseImplementationDigestInput(input, "$implementation_digest"));
}

/**
 * Build an independent descriptor closure without changing DatasetTransform's
 * already published shape or wiring any production caller.
 */
export function buildTransformDescriptorDigestCanonical(
  input: TransformDescriptorDigestInput,
): string {
  return stableStringify(parseTransformDescriptorDigestInput(input, "$transform_descriptor_digest"));
}

function toHex(buffer: ArrayBuffer): string {  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Canonical(canonical: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonical);
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.subtle) {
    throw new APIError(500, "Web Crypto (crypto.subtle) is unavailable in this environment");
  }
  return toHex(await cryptoObject.subtle.digest("SHA-256", bytes));
}

/** Canonical bytes for FamilySpec identity; every array preserves declaration order. */
export function buildFamilySpecDigestCanonical(spec: FamilySpec): string {
  return stableStringify(familySpecDigestBody(spec));
}

/** Compute FamilySpec identity without trusting the embedded canonical_digest. */
export async function computeFamilySpecDigest(spec: FamilySpec): Promise<string> {
  return sha256Canonical(buildFamilySpecDigestCanonical(spec));
}

/** Explicit verification boundary; parseFamilySpec alone does not confer digest trust. */
export async function verifyFamilySpecDigest(spec: FamilySpec): Promise<boolean> {
  const parsed = parseFamilySpec(spec, "$family_spec");
  return (await computeFamilySpecDigest(parsed)) === parsed.canonical_digest;
}

/** Host-computed SHA-256 over the frozen implementation canonical bytes. */
export async function computeImplementationDigest(input: ImplementationDigestInput): Promise<string> {
  return sha256Canonical(buildImplementationDigestCanonical(input));
}
