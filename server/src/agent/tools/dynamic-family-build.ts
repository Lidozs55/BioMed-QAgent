import { types } from "node:util";

import {
  parseDatasetBuildProposal2,
  parseDatasetTransform,
  parseFamilySpec,
  verifyFamilySpecDigest,
  type DatasetBuildProposal2,
  type DatasetTransform,
  type FamilySpec,
  type Projection,
} from "@biomed/contracts";

import { canonicalDigest } from "../../dataset/adapters/identity.js";

const TOP_KEYS = new Set([
  "schema_version",
  "execution_backend",
  "family_spec",
  "projection_id",
  "transform_source",
  "transform_metadata",
  "build_proposal",
]);
const MAX_SOURCE_BYTES = 256 * 1024;
const HEX = "0".repeat(64);

type DataRecord = Record<string, unknown>;

export interface ParsedDynamicFamilyBuildSubmission {
  readonly schema_version: "1.0";
  readonly execution_backend: "in_process_unisolated";
  readonly family_spec: FamilySpec;
  readonly projection: Projection;
  readonly transform_source: string;
  readonly transform_metadata: Omit<DatasetTransform,
    | "source_digest" | "bundle_digest" | "compiler_id" | "compiler_version"
    | "compiler_options_digest" | "runtime_abi_version" | "runtime_policy_version"
    | "dependency_closure_digest" | "code_bundle_ref">;
  readonly build_proposal: DatasetBuildProposal2;
}

/** Strict wire boundary only. It never executes code or grants publication authority. */
export async function parseDynamicFamilyBuildSubmission(
  value: unknown,
): Promise<ParsedDynamicFamilyBuildSubmission> {
  const record = exactDataRecord(value, TOP_KEYS, "$dynamic_family_build");
  if (record.schema_version !== "1.0") throw new TypeError("dynamic family build schema_version must be 1.0");
  if (record.execution_backend !== "in_process_unisolated") {
    throw new TypeError("dynamic family builds require the explicit in_process_unisolated backend");
  }
  const family = parseFamilySpec(record.family_spec, "$.family_spec");
  if (family.scope === "example") throw new TypeError("example FamilySpec cannot execute");
  if (!(await verifyFamilySpecDigest(family))) throw new TypeError("FamilySpec canonical digest is invalid");
  if (typeof record.projection_id !== "string") throw new TypeError("projection_id must be a string");
  const projection = family.projections.find((item) => item.projection_id === record.projection_id);
  if (projection === undefined) throw new TypeError(`unknown FamilySpec projection '${record.projection_id}'`);
  const source = sourceText(record.transform_source);
  const transform = parseMetadata(record.transform_metadata);
  if (
    transform.scope === "example"
    || transform.bound_family_spec_digest !== family.canonical_digest
    || transform.bound_projection_digest !== projectionDigest(projection)
  ) {
    throw new TypeError("transform metadata does not bind the selected executable FamilySpec projection");
  }
  const proposal = parseDatasetBuildProposal2(record.build_proposal, "$.build_proposal");
  if (
    proposal.family_spec_ref.id !== family.family_spec_id
    || proposal.family_spec_ref.version !== family.semantic_version
    || proposal.family_spec_ref.digest !== family.canonical_digest
    || proposal.family_spec_ref.scope !== family.scope
    || proposal.projection_ref !== projection.projection_id
  ) {
    throw new TypeError("build proposal does not bind the exact FamilySpec projection");
  }
  return Object.freeze({
    schema_version: "1.0",
    execution_backend: "in_process_unisolated",
    family_spec: family,
    projection,
    transform_source: source,
    transform_metadata: transform,
    build_proposal: proposal,
  });
}

function parseMetadata(value: unknown): ParsedDynamicFamilyBuildSubmission["transform_metadata"] {
  const parsed = parseDatasetTransform({
    ...exactDataRecord(value, new Set([
      "transform_id", "version", "entrypoint", "declared_input_roles",
      "declared_output_tables", "bound_family_spec_digest", "bound_projection_digest",
      "determinism_profile", "resource_class", "origin", "scope", "review_refs",
    ]), "$.transform_metadata"),
    source_digest: HEX,
    bundle_digest: HEX,
    compiler_id: "pending",
    compiler_version: "pending",
    compiler_options_digest: HEX,
    runtime_abi_version: "pending",
    runtime_policy_version: "pending",
    dependency_closure_digest: HEX,
    code_bundle_ref: `bundle_${HEX}`,
  }, "$.transform_metadata");
  return Object.freeze({
    transform_id: parsed.transform_id,
    version: parsed.version,
    entrypoint: parsed.entrypoint,
    declared_input_roles: parsed.declared_input_roles,
    declared_output_tables: parsed.declared_output_tables,
    bound_family_spec_digest: parsed.bound_family_spec_digest,
    bound_projection_digest: parsed.bound_projection_digest,
    determinism_profile: parsed.determinism_profile,
    resource_class: parsed.resource_class,
    origin: parsed.origin,
    scope: parsed.scope,
    review_refs: parsed.review_refs,
  });
}

function exactDataRecord(value: unknown, keys: ReadonlySet<string>, label: string): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(`${label} must be a plain non-Proxy object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must have a plain prototype`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  const result = Object.create(null) as DataRecord;
  for (const key of ownKeys) {
    const descriptor = descriptors[key as string];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${String(key)} must be an enumerable data property`);
    }
    result[key as string] = descriptor.value;
  }
  return result;
}

function sourceText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.normalize("NFC") !== value) {
    throw new TypeError("transform_source must be non-empty NFC text");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SOURCE_BYTES || [...value].some((character) => {
    const point = character.codePointAt(0)!;
    return point === 0 || (point >= 0xd800 && point <= 0xdfff);
  })) throw new TypeError("transform_source is invalid or exceeds 256 KiB");
  return value;
}

function projectionDigest(projection: Projection): string {
  return canonicalDigest(projection);
}
