/**
 * Family Host + Transform Host — frozen contract types & strict parsers (M1).
 *
 * Single source of truth for the data contracts that groups B (Transform Host)
 * and C (Core admission / validation) consume. These are the agreed interfaces
 * from `docs/plans/family-host/` (`01-family-transform-contracts`,
 * `02-product-identity-relations`, `03-transform-host-security`):
 *
 * - A-T1: FamilySpec / DatasetTransform / TransformExecutionReceipt / BuildSpec 2.0
 * - A-T2: identity / projection / relation / audit contracts
 * - A-T3: implementation identity digest (canonicalization + SHA-256)
 *
 * Parsers are STRICT: unknown fields fail closed (per A-T1 acceptance), matching
 * the server-side `extra="forbid"` domain layer. This file intentionally does not
 * modify the frozen `DatasetBuildSpec` ("1.0") in `dataset-build.ts`.
 *
 * NOTE: import of `node:crypto` is avoided — the digest is computed with Web
 * Crypto (`globalThis.crypto.subtle`), which is available in both Node and the
 * browser, keeping this module frontend-safe.
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
  assertHex64,
  assertJsonRecord,
  assertNonNegativeInt,
  assertObject,
  assertString,
  assertStringOrNull,
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
const MAPPING_STATUSES = ["mapped", "unmapped", "ambiguous"] as const;

/* ------------------------------------------------------------------ */
/* Strict object helper (fail closed on unknown keys)                  */
/* ------------------------------------------------------------------ */

function strictObject(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  const obj = assertObject(value, path);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new APIError(502, `Unknown field "${key}" at ${path}`);
    }
  }
  return obj;
}

function getStr(obj: Record<string, unknown>, key: string, path: string, nonEmpty = false): string {
  return assertString(Reflect.get(obj, key), `${path}.${key}`, nonEmpty);
}
function getStrOrNull(obj: Record<string, unknown>, key: string, path: string): string | null {
  return assertStringOrNull(Reflect.get(obj, key), `${path}.${key}`);
}
function getArr<T>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  item: (v: unknown, i: number) => T,
): T[] {
  return assertArray(Reflect.get(obj, key), `${path}.${key}`, item);
}

/* ------------------------------------------------------------------ */
/* A-T2: identity / projection / relation / audit                      */
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
  const obj = strictObject(value, path, IDENTITY_KEYS);
  return {
    dataset_id_scheme: "ds_hash",
    dataset_revision_id_scheme: "dsrev_hash",
    asset_id_scheme: "asset_sha256",
    sample_identity_fields: getArr(obj, "sample_identity_fields", path, (v, i) =>
      assertString(v, `${path}.sample_identity_fields[${i}]`, true),
    ),
    probe_mapping_assertion_pk: getStr(obj, "probe_mapping_assertion_pk", path, true),
  };
}

export function parseDatasetIdentity(value: unknown, path: string): DatasetIdentity {
  const obj = strictObject(value, path, DATASET_IDENTITY_KEYS);
  const dataset_id = getStr(obj, "dataset_id", path, true);
  if (dataset_id.startsWith("build_")) {
    throw new APIError(502, `dataset_id must not equal a build_id at ${path}`);
  }
  return {
    dataset_id,
    dataset_revision_id: getStr(obj, "dataset_revision_id", path, true),
    asset_id: getStr(obj, "asset_id", path, true),
  };
}

export function parseSampleIdentity(value: unknown, path: string): SampleIdentity {
  const obj = strictObject(value, path, SAMPLE_IDENTITY_KEYS);
  return {
    dataset_revision_id: getStr(obj, "dataset_revision_id", path, true),
    sample_id: getStr(obj, "sample_id", path, true),
  };
}

export function parseProbeMappingAssertion(value: unknown, path: string): ProbeMappingAssertion {
  const obj = strictObject(value, path, PROBE_KEYS);
  const status = assertString(Reflect.get(obj, "mapping_status"), `${path}.mapping_status`);
  if (!(MAPPING_STATUSES as readonly string[]).includes(status)) {
    throw new APIError(502, `Invalid mapping_status "${status}" at ${path}.mapping_status`);
  }
  return {
    mapping_assertion_id: getStr(obj, "mapping_assertion_id", path, true),
    dataset_revision_id: getStr(obj, "dataset_revision_id", path, true),
    mapping_scope_id: getStr(obj, "mapping_scope_id", path, true),
    platform_id: getStr(obj, "platform_id", path, true),
    probe_id: getStr(obj, "probe_id", path, true),
    target_gene_id: getStrOrNull(obj, "target_gene_id", path),
    target_namespace: getStrOrNull(obj, "target_namespace", path),
    annotation_asset_id: getStr(obj, "annotation_asset_id", path, true),
    mapping_rule_id: getStr(obj, "mapping_rule_id", path, true),
    mapping_status: status as ProbeMappingAssertion["mapping_status"],
  };
}

export function parseAuditArtifactDefinition(value: unknown, path: string): AuditArtifactDefinition {
  const obj = strictObject(value, path, AUDIT_KEYS);
  const appendOnly = assertBoolean(Reflect.get(obj, "append_only"), `${path}.append_only`);
  if (appendOnly !== true) {
    throw new APIError(502, `AuditArtifactDefinition.append_only must be true at ${path}`);
  }
  return {
    artifact_id: getStr(obj, "artifact_id", path, true),
    schema_ref: getStr(obj, "schema_ref", path, true),
    fields: getArr(obj, "fields", path, (v, i) => assertString(v, `${path}.fields[${i}]`, true)),
    locator_ref: getStr(obj, "locator_ref", path, true),
    receipt_ref: getStr(obj, "receipt_ref", path, true),
    append_only: true,
  };
}

export function parseProjection(value: unknown, path: string): Projection {
  const obj = strictObject(value, path, PROJECTION_KEYS);
  const sv = assertString(Reflect.get(obj, "schema_version"), `${path}.schema_version`);
  if (sv !== "2.0") throw new APIError(502, `Projection.schema_version must be "2.0" at ${path}`);
  const strArr = (k: string) => getArr(obj, k, path, (v, i) => assertString(v, `${path}.${k}[${i}]`, true));
  return {
    projection_id: getStr(obj, "projection_id", path, true),
    schema_version: "2.0",
    primary_tables: strArr("primary_tables"),
    supporting_tables: strArr("supporting_tables"),
    derived_tables: strArr("derived_tables"),
    required: strArr("required"),
    optional: strArr("optional"),
    allow_empty: strArr("allow_empty"),
    relations: strArr("relations"),
    row_granularity: getStr(obj, "row_granularity", path, true),
    compatibility_dimensions: strArr("compatibility_dimensions"),
    merge_identity_fields: strArr("merge_identity_fields"),
    validation_policy_ref: getStr(obj, "validation_policy_ref", path, true),
    assessment_policy_ref: getStr(obj, "assessment_policy_ref", path, true),
  };
}

/* ------------------------------------------------------------------ */
/* A-T1: scope-qualified ref, FamilySpec, DatasetTransform, receipt    */
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
}
export interface InputResultReceipt {
  result_manifest_id: string;
  sha256: string;
}
export interface OutputReceipt {
  table_id: string;
  schema_ref: string;
  artifact_ref: string;
  sha256: string;
  row_count: number;
}
export interface ResourceLimits {
  cpu_ms: number;
  rss_bytes: number;
  temp_bytes: number;
  output_bytes: number;
  open_files: number;
}

export interface TransformExecutionReceipt {
  task_id: string;
  run_id: string;
  build_id: string;
  invocation_id: string;
  attempt: number;
  generation: number;
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
  exit_state: TerminalReason;
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
  cancellation_state: string;
  host_implementation_digest: string;
  host_issued_at: string;
}

export interface DatasetBuildSpec2 {
  schema_version: "2.0";
  build_id: string;
  family_spec_ref: ScopeQualifiedRef;
  projection_ref: string;
  source_bindings: BuildSpec2SourceBinding[];
  transform_refs: ScopeQualifiedRef[];
  policy_refs: ScopeQualifiedRef[];
  output_format: string;
  idempotency_identity: string;
}

export interface BuildSpec2SourceBinding {
  binding_id: string;
  source: string;
  registered_asset_ref: string | null;
  registered_result_ref: string | null;
  parameters: Record<string, JsonValue>;
}

const SCOPE_REF_KEYS = new Set(["scope", "id", "version", "digest"]);
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
  "determinism_profile",
  "resource_class",
  "origin",
  "scope",
  "review_refs",
]);
const RECEIPT_KEYS = new Set([
  "task_id",
  "run_id",
  "build_id",
  "invocation_id",
  "attempt",
  "generation",
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
  "exit_state",
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
  "host_implementation_digest",
  "host_issued_at",
]);
const BUILD2_KEYS = new Set([
  "schema_version",
  "build_id",
  "family_spec_ref",
  "projection_ref",
  "source_bindings",
  "transform_refs",
  "policy_refs",
  "output_format",
  "idempotency_identity",
]);
const BINDING2_KEYS = new Set([
  "binding_id",
  "source",
  "registered_asset_ref",
  "registered_result_ref",
  "parameters",
]);

function parseScope(value: unknown, path: string): TransformScope {
  const s = assertString(value, path);
  if (!(TRANSFORM_SCOPES as readonly string[]).includes(s)) {
    throw new APIError(502, `Invalid TransformScope "${s}" at ${path}`);
  }
  return s as TransformScope;
}

export function parseScopeQualifiedRef(value: unknown, path: string): ScopeQualifiedRef {
  const obj = strictObject(value, path, SCOPE_REF_KEYS);
  return {
    scope: parseScope(Reflect.get(obj, "scope"), `${path}.scope`),
    id: getStr(obj, "id", path, true),
    version: getStr(obj, "version", path, true),
    digest: assertHex64(Reflect.get(obj, "digest"), `${path}.digest`),
  };
}

function parseDeclaredInputRole(value: unknown, path: string): DeclaredInputRole {
  const obj = strictObject(value, path, new Set(["role", "media_type", "constraint_ref"]));
  return {
    role: getStr(obj, "role", path, true),
    media_type: getStr(obj, "media_type", path, true),
    constraint_ref: getStrOrNull(obj, "constraint_ref", path),
  };
}

function parseDeclaredTableRef(value: unknown, path: string): DeclaredTableRef {
  const obj = strictObject(value, path, new Set(["table_id", "schema_ref"]));
  return {
    table_id: getStr(obj, "table_id", path, true),
    schema_ref: getStr(obj, "schema_ref", path, true),
  };
}

function parseBuildSpec2SourceBinding(value: unknown, path: string): BuildSpec2SourceBinding {
  const obj = strictObject(value, path, BINDING2_KEYS);
  return {
    binding_id: getStr(obj, "binding_id", path, true),
    source: getStr(obj, "source", path, true),
    registered_asset_ref: getStrOrNull(obj, "registered_asset_ref", path),
    registered_result_ref: getStrOrNull(obj, "registered_result_ref", path),
    parameters: assertJsonRecord(Reflect.get(obj, "parameters"), `${path}.parameters`),
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
  const obj = strictObject(value, path, TABLE_DEFINITION_KEYS);
  const role = assertString(Reflect.get(obj, "role"), `${path}.role`);
  if (!(TABLE_ROLES as readonly string[]).includes(role)) {
    throw new APIError(502, `Invalid TableRole "${role}" at ${path}.role`);
  }
  return {
    table_id: getStr(obj, "table_id", path, true),
    schema_ref: getStr(obj, "schema_ref", path, true),
    role: role as TableRole,
    required: assertBoolean(Reflect.get(obj, "required"), `${path}.required`),
    allow_empty: assertBoolean(Reflect.get(obj, "allow_empty"), `${path}.allow_empty`),
    primary_key: getArr(obj, "primary_key", path, (v, i) =>
      assertString(v, `${path}.primary_key[${i}]`, true),
    ),
    field_names: getArr(obj, "field_names", path, (v, i) =>
      assertString(v, `${path}.field_names[${i}]`, true),
    ),
  };
}

function parseRelationDefinition(value: unknown, path: string): RelationDefinition {
  const obj = strictObject(value, path, RELATION_DEFINITION_KEYS);
  const cardinality = assertString(Reflect.get(obj, "cardinality"), `${path}.cardinality`);
  if (!(RELATION_CARDINALITIES as readonly string[]).includes(cardinality)) {
    throw new APIError(502, `Invalid cardinality "${cardinality}" at ${path}.cardinality`);
  }
  const missingPolicy = assertString(Reflect.get(obj, "missing_policy"), `${path}.missing_policy`);
  if (!(RELATION_MISSING_POLICIES as readonly string[]).includes(missingPolicy)) {
    throw new APIError(502, `Invalid missing_policy "${missingPolicy}" at ${path}.missing_policy`);
  }
  return {
    relation_id: getStr(obj, "relation_id", path, true),
    from_table_id: getStr(obj, "from_table_id", path, true),
    from_fields: getArr(obj, "from_fields", path, (v, i) =>
      assertString(v, `${path}.from_fields[${i}]`, true),
    ),
    to_table_id: getStr(obj, "to_table_id", path, true),
    to_fields: getArr(obj, "to_fields", path, (v, i) =>
      assertString(v, `${path}.to_fields[${i}]`, true),
    ),
    cardinality: cardinality as RelationCardinality,
    missing_policy: missingPolicy as RelationMissingPolicy,
  };
}

export function parseFamilySpec(value: unknown, path: string): FamilySpec {
  const obj = strictObject(value, path, FAMILY_KEYS);
  return {
    family_spec_id: getStr(obj, "family_spec_id", path, true),
    semantic_version: getStr(obj, "semantic_version", path, true),
    canonical_digest: assertHex64(Reflect.get(obj, "canonical_digest"), `${path}.canonical_digest`),
    projections: getArr(obj, "projections", path, (v, i) => parseProjection(v, `${path}.projections[${i}]`)),
    table_definitions: getArr(obj, "table_definitions", path, (v, i) =>
      parseTableDefinition(v, `${path}.table_definitions[${i}]`),
    ),
    relations: getArr(obj, "relations", path, (v, i) =>
      parseRelationDefinition(v, `${path}.relations[${i}]`),
    ),
    identity: parseIdentityContract(Reflect.get(obj, "identity"), `${path}.identity`),
    transform_capability_refs: getArr(obj, "transform_capability_refs", path, (v, i) =>
      assertString(v, `${path}.transform_capability_refs[${i}]`, true),
    ),
    declared_outputs: getArr(obj, "declared_outputs", path, (v, i) =>
      parseDeclaredTableRef(v, `${path}.declared_outputs[${i}]`),
    ),
    integration_policy_ref: getStr(obj, "integration_policy_ref", path, true),
    validation_policy_ref: getStr(obj, "validation_policy_ref", path, true),
    assessment_policy_ref: getStr(obj, "assessment_policy_ref", path, true),
    resource_class_request: getStr(obj, "resource_class_request", path, true),
    scope: parseScope(Reflect.get(obj, "scope"), `${path}.scope`),
    author: getStr(obj, "author", path, true),
    evidence_refs: getArr(obj, "evidence_refs", path, (v, i) =>
      assertString(v, `${path}.evidence_refs[${i}]`, true),
    ),
  };
}

export function parseDatasetTransform(value: unknown, path: string): DatasetTransform {
  const obj = strictObject(value, path, TRANSFORM_KEYS);
  const determinism = assertString(Reflect.get(obj, "determinism_profile"), `${path}.determinism_profile`);
  if (!(DETERMINISM_PROFILES as readonly string[]).includes(determinism)) {
    throw new APIError(502, `Invalid determinism_profile "${determinism}" at ${path}.determinism_profile`);
  }
  return {
    transform_id: getStr(obj, "transform_id", path, true),
    version: getStr(obj, "version", path, true),
    source_digest: assertHex64(Reflect.get(obj, "source_digest"), `${path}.source_digest`),
    bundle_digest: assertHex64(Reflect.get(obj, "bundle_digest"), `${path}.bundle_digest`),
    compiler_id: getStr(obj, "compiler_id", path, true),
    compiler_version: getStr(obj, "compiler_version", path, true),
    compiler_options_digest: assertHex64(
      Reflect.get(obj, "compiler_options_digest"),
      `${path}.compiler_options_digest`,
    ),
    runtime_abi_version: getStr(obj, "runtime_abi_version", path, true),
    runtime_policy_version: getStr(obj, "runtime_policy_version", path, true),
    dependency_closure_digest: assertHex64(
      Reflect.get(obj, "dependency_closure_digest"),
      `${path}.dependency_closure_digest`,
    ),
    code_bundle_ref: getStr(obj, "code_bundle_ref", path, true),
    entrypoint: getStr(obj, "entrypoint", path, true),
    declared_input_roles: getArr(obj, "declared_input_roles", path, (v, i) =>
      parseDeclaredInputRole(v, `${path}.declared_input_roles[${i}]`),
    ),
    declared_output_tables: getArr(obj, "declared_output_tables", path, (v, i) =>
      parseDeclaredTableRef(v, `${path}.declared_output_tables[${i}]`),
    ),
    bound_family_spec_digest: assertHex64(
      Reflect.get(obj, "bound_family_spec_digest"),
      `${path}.bound_family_spec_digest`,
    ),
    determinism_profile: determinism as DeterminismProfile,
    resource_class: getStr(obj, "resource_class", path, true),
    origin: getStr(obj, "origin", path, true),
    scope: parseScope(Reflect.get(obj, "scope"), `${path}.scope`),
    review_refs: getArr(obj, "review_refs", path, (v, i) => assertString(v, `${path}.review_refs[${i}]`, true)),
  };
}

function parseInputAssetReceipt(value: unknown, path: string): InputAssetReceipt {
  const obj = strictObject(value, path, new Set(["asset_id", "role", "sha256", "size_bytes"]));
  return {
    asset_id: getStr(obj, "asset_id", path, true),
    role: getStr(obj, "role", path, true),
    sha256: assertHex64(Reflect.get(obj, "sha256"), `${path}.sha256`),
    size_bytes: assertNonNegativeInt(Reflect.get(obj, "size_bytes"), `${path}.size_bytes`),
  };
}
function parseInputResultReceipt(value: unknown, path: string): InputResultReceipt {
  const obj = strictObject(value, path, new Set(["result_manifest_id", "sha256"]));
  return {
    result_manifest_id: getStr(obj, "result_manifest_id", path, true),
    sha256: assertHex64(Reflect.get(obj, "sha256"), `${path}.sha256`),
  };
}
function parseOutputReceipt(value: unknown, path: string): OutputReceipt {
  const obj = strictObject(value, path, new Set(["table_id", "schema_ref", "artifact_ref", "sha256", "row_count"]));
  return {
    table_id: getStr(obj, "table_id", path, true),
    schema_ref: getStr(obj, "schema_ref", path, true),
    artifact_ref: getStr(obj, "artifact_ref", path, true),
    sha256: assertHex64(Reflect.get(obj, "sha256"), `${path}.sha256`),
    row_count: assertNonNegativeInt(Reflect.get(obj, "row_count"), `${path}.row_count`),
  };
}
function parseResourceLimits(value: unknown, path: string): ResourceLimits {
  const obj = strictObject(value, path, new Set(["cpu_ms", "rss_bytes", "temp_bytes", "output_bytes", "open_files"]));
  return {
    cpu_ms: assertNonNegativeInt(Reflect.get(obj, "cpu_ms"), `${path}.cpu_ms`),
    rss_bytes: assertNonNegativeInt(Reflect.get(obj, "rss_bytes"), `${path}.rss_bytes`),
    temp_bytes: assertNonNegativeInt(Reflect.get(obj, "temp_bytes"), `${path}.temp_bytes`),
    output_bytes: assertNonNegativeInt(Reflect.get(obj, "output_bytes"), `${path}.output_bytes`),
    open_files: assertNonNegativeInt(Reflect.get(obj, "open_files"), `${path}.open_files`),
  };
}

export function parseTransformExecutionReceipt(value: unknown, path: string): TransformExecutionReceipt {
  const obj = strictObject(value, path, RECEIPT_KEYS);
  const exit = assertString(Reflect.get(obj, "exit_state"), `${path}.exit_state`);
  if (!(TERMINAL_REASONS as readonly string[]).includes(exit)) {
    throw new APIError(502, `Invalid exit_state "${exit}" at ${path}.exit_state`);
  }
  return {
    task_id: getStr(obj, "task_id", path, true),
    run_id: getStr(obj, "run_id", path, true),
    build_id: getStr(obj, "build_id", path, true),
    invocation_id: getStr(obj, "invocation_id", path, true),
    attempt: assertNonNegativeInt(Reflect.get(obj, "attempt"), `${path}.attempt`),
    generation: assertNonNegativeInt(Reflect.get(obj, "generation"), `${path}.generation`),
    family_spec_digest: assertHex64(Reflect.get(obj, "family_spec_digest"), `${path}.family_spec_digest`),
    projection_digest: assertHex64(Reflect.get(obj, "projection_digest"), `${path}.projection_digest`),
    transform_digest: assertHex64(Reflect.get(obj, "transform_digest"), `${path}.transform_digest`),
    bundle_digest: assertHex64(Reflect.get(obj, "bundle_digest"), `${path}.bundle_digest`),
    compiler_digest: assertHex64(Reflect.get(obj, "compiler_digest"), `${path}.compiler_digest`),
    runtime_digest: assertHex64(Reflect.get(obj, "runtime_digest"), `${path}.runtime_digest`),
    policy_digest: assertHex64(Reflect.get(obj, "policy_digest"), `${path}.policy_digest`),
    input_asset_receipts: getArr(obj, "input_asset_receipts", path, (v, i) =>
      parseInputAssetReceipt(v, `${path}.input_asset_receipts[${i}]`),
    ),
    input_result_receipts: getArr(obj, "input_result_receipts", path, (v, i) =>
      parseInputResultReceipt(v, `${path}.input_result_receipts[${i}]`),
    ),
    granted_capabilities: getArr(obj, "granted_capabilities", path, (v, i) =>
      assertString(v, `${path}.granted_capabilities[${i}]`, true),
    ),
    resource_limits: parseResourceLimits(Reflect.get(obj, "resource_limits"), `${path}.resource_limits`),
    exit_state: exit as TerminalReason,
    wall_ms: assertNonNegativeInt(Reflect.get(obj, "wall_ms"), `${path}.wall_ms`),
    cpu_ms: assertNonNegativeInt(Reflect.get(obj, "cpu_ms"), `${path}.cpu_ms`),
    rss_bytes: assertNonNegativeInt(Reflect.get(obj, "rss_bytes"), `${path}.rss_bytes`),
    temp_bytes: assertNonNegativeInt(Reflect.get(obj, "temp_bytes"), `${path}.temp_bytes`),
    output_bytes: assertNonNegativeInt(Reflect.get(obj, "output_bytes"), `${path}.output_bytes`),
    log_bytes: assertNonNegativeInt(Reflect.get(obj, "log_bytes"), `${path}.log_bytes`),
    quarantined_output_receipts: getArr(obj, "quarantined_output_receipts", path, (v, i) =>
      parseOutputReceipt(v, `${path}.quarantined_output_receipts[${i}]`),
    ),
    stdout_ref: getStr(obj, "stdout_ref", path, true),
    stderr_ref: getStr(obj, "stderr_ref", path, true),
    audit_refs: getArr(obj, "audit_refs", path, (v, i) => assertString(v, `${path}.audit_refs[${i}]`, true)),
    cancellation_state: getStr(obj, "cancellation_state", path, true),
    host_implementation_digest: assertHex64(
      Reflect.get(obj, "host_implementation_digest"),
      `${path}.host_implementation_digest`,
    ),
    host_issued_at: getStr(obj, "host_issued_at", path, true),
  };
}

export function parseDatasetBuildSpec2(value: unknown, path: string): DatasetBuildSpec2 {
  const obj = strictObject(value, path, BUILD2_KEYS);
  const sv = assertString(Reflect.get(obj, "schema_version"), `${path}.schema_version`);
  if (sv !== "2.0") throw new APIError(502, `DatasetBuildSpec2.schema_version must be "2.0" at ${path}`);
  return {
    schema_version: "2.0",
    build_id: getStr(obj, "build_id", path, true),
    family_spec_ref: parseScopeQualifiedRef(Reflect.get(obj, "family_spec_ref"), `${path}.family_spec_ref`),
    projection_ref: getStr(obj, "projection_ref", path, true),
    source_bindings: getArr(obj, "source_bindings", path, (v, i) =>
      parseBuildSpec2SourceBinding(v, `${path}.source_bindings[${i}]`),
    ),
    transform_refs: getArr(obj, "transform_refs", path, (v, i) =>
      parseScopeQualifiedRef(v, `${path}.transform_refs[${i}]`),
    ),
    policy_refs: getArr(obj, "policy_refs", path, (v, i) =>
      parseScopeQualifiedRef(v, `${path}.policy_refs[${i}]`),
    ),
    output_format: getStr(obj, "output_format", path, true),
    idempotency_identity: getStr(obj, "idempotency_identity", path, true),
  };
}

/* ------------------------------------------------------------------ */
/* A-T3: implementation identity digest (frozen canonicalization)      */
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

function nfc(s: string): string {
  return s.normalize("NFC");
}

/**
 * Deterministic, key-sorted, unicode-normalized JSON serialization.
 * Used as the frozen byte contract for the implementation digest.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(nfc(value));
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]));
    return "{" + entries.join(",") + "}";
  }
  throw new APIError(502, `Cannot canonicalize value of type ${typeof value}`);
}

/** Build the canonical byte string for the implementation digest (A-T3). */
export function buildImplementationDigestCanonical(input: ImplementationDigestInput): string {
  return stableStringify({
    normalized_source_sha256: input.normalized_source_sha256,
    emitted_bundle_sha256: input.emitted_bundle_sha256,
    compiler_id: input.compiler_id,
    compiler_version: input.compiler_version,
    compiler_options_digest: input.compiler_options_digest,
    dependency_closure_digest: input.dependency_closure_digest,
    runtime_abi_version: input.runtime_abi_version,
    host_policy_version: input.host_policy_version,
  });
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute the implementation digest = SHA-256 over the canonical bytes.
 * Uses Web Crypto so this module stays frontend-safe. The Host is the only
 * party that calls this (A-T3: digest must be Host-computed, not declared).
 */
export async function computeImplementationDigest(input: ImplementationDigestInput): Promise<string> {
  const canonical = buildImplementationDigestCanonical(input);
  const bytes = new TextEncoder().encode(canonical);
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) throw new APIError(500, "Web Crypto (crypto.subtle) is unavailable in this environment");
  const digest = await cryptoObj.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}
