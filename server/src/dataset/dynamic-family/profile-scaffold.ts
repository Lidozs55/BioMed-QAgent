import type {
  FamilySpec,
  JsonValue,
  Projection,
  SourceBindingKind,
} from "@biomed/contracts";

import { resolveCoreProductProfileDescriptor } from "../families/index.js";

const AGENT_SUPPLIED_FIELDS = Object.freeze([
  "source_bindings",
  "registered_sources_or_acquisition_requests",
  "transform_source",
  "transform_input_roles",
] as const);

export interface CoreProfileSubmissionBinding {
  readonly binding_id: string;
  readonly source: string;
  readonly input_requirement_ref: string;
  /**
   * Optional explicit binding role; legacy/absent normalizes to
   * ``transform_input``. provenance_only bindings still carry one declared
   * input role (for their provenance media type) but are never decoded into
   * transform runtime inputs.
   */
  readonly binding_kind?: SourceBindingKind;
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface CoreProfileTransformInputRole {
  readonly role: string;
  readonly media_type: string;
  readonly constraint_ref: string | null;
}

export interface BuildCoreProfilePrepareSubmissionInput {
  readonly profileRef: string;
  readonly requirementId: string;
  readonly sourceBindings: readonly CoreProfileSubmissionBinding[];
  readonly registeredSources: Readonly<Record<string, string>>;
  readonly acquisitionRequests: Readonly<Record<string, {
    readonly provider_id: string;
    readonly parameters: Readonly<Record<string, JsonValue>>;
  }>>;
  readonly transformSource: string;
  readonly transformInputRoles: readonly CoreProfileTransformInputRole[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const ASSET_ID = /^asset_[0-9a-f]{64}$/u;

function safeId(value: string, name: string): string {
  if (!SAFE_ID.test(value)) throw new TypeError(`${name} must be a safe identifier`);
  return value;
}

/** Build the exact prepare wire while leaving only source/extraction facts caller-owned. */
export function buildCoreProfilePrepareSubmission(
  input: BuildCoreProfilePrepareSubmissionInput,
): Readonly<Record<string, unknown>> {
  const scaffold = coreProductProfileScaffold(input.profileRef);
  safeId(input.requirementId, "requirementId");
  if (input.sourceBindings.length === 0) {
    throw new TypeError("profile scaffold requires at least one source binding");
  }
  if (!input.sourceBindings.some((binding) => (binding.binding_kind ?? "transform_input") === "transform_input")) {
    throw new TypeError("profile scaffold requires at least one transform_input binding; provenance_only bindings cannot feed the transform runtime");
  }
  // transformInputRoles closes ONLY the transform_input bindings, preserving
  // their source-binding order; provenance-only bindings carry no declared role.
  const transformBindings = input.sourceBindings.filter(
    (binding) => (binding.binding_kind ?? "transform_input") === "transform_input",
  );
  if (transformBindings.length !== input.transformInputRoles.length) {
    throw new TypeError(
      `profile scaffold declared input roles (${input.transformInputRoles.length}) do not close the transform_input bindings (${transformBindings.length})`,
    );
  }
  const bindingIds = input.sourceBindings.map((binding) => safeId(binding.binding_id, "binding_id"));
  if (new Set(bindingIds).size !== bindingIds.length) throw new TypeError("profile scaffold binding IDs must be unique");
  let transformRoleIndex = 0;
  input.sourceBindings.forEach((binding) => {
    safeId(binding.source, `sourceBindings[${binding.binding_id}].source`);
    safeId(binding.input_requirement_ref, `sourceBindings[${binding.binding_id}].input_requirement_ref`);
    if ((binding.binding_kind ?? "transform_input") !== "transform_input") return;
    if (input.transformInputRoles[transformRoleIndex]?.role !== binding.input_requirement_ref) {
      throw new TypeError(`profile scaffold input role does not match binding '${binding.binding_id}'`);
    }
    transformRoleIndex += 1;
  });
  const registered = Object.keys(input.registeredSources);
  const acquisitions = Object.keys(input.acquisitionRequests);
  const closure = [...registered, ...acquisitions].sort();
  const expected = [...bindingIds].sort();
  if (closure.length !== expected.length || closure.some((value, index) => value !== expected[index])) {
    throw new TypeError("registered sources and acquisition requests must exactly close scaffold bindings");
  }
  for (const [bindingId, assetId] of Object.entries(input.registeredSources)) {
    if (!bindingIds.includes(bindingId) || !ASSET_ID.test(assetId)) {
      throw new TypeError(`registered source '${bindingId}' is invalid`);
    }
  }
  if (typeof input.transformSource !== "string" || input.transformSource.trim() === "") {
    throw new TypeError("profile scaffold requires non-empty transform source");
  }
  const transformId = `${scaffold.dataset_family}.profile_transform`;
  const transformVersion = "1.0.0";
  return Object.freeze({
    schema_version: "1.0",
    execution_backend: "in_process_unisolated",
    family_spec: scaffold.family_spec,
    projection_id: scaffold.projection.projection_id,
    transform_source: input.transformSource,
    transform_metadata: {
      transform_id: transformId,
      version: transformVersion,
      entrypoint: "transform.run",
      declared_input_roles: input.transformInputRoles.map((role) => ({ ...role })),
      declared_output_tables: scaffold.transform_output_tables.map((table) => ({ ...table })),
      determinism_profile: "deterministic",
      resource_class: "small",
      origin: "profile_scaffold",
      scope: "task",
      review_refs: [],
    },
    execution_proposal: {
      schema_version: "2.0",
      spec_kind: "proposal",
      requirement_id: input.requirementId,
      family_spec_ref: {
        scope: "task",
        id: scaffold.family_spec.family_spec_id,
        version: scaffold.family_spec.semantic_version,
      },
      projection_ref: scaffold.projection.projection_id,
      source_bindings: input.sourceBindings.map((binding) => ({
        ...binding,
        parameters: { ...binding.parameters },
      })),
      transform_refs: [{ scope: "task", id: transformId, version: transformVersion }],
      policy_refs: [],
      output_format: "csv",
      idempotency_identity: `${input.requirementId}_${scaffold.dataset_family}`.slice(0, 256),
    },
    registered_sources: { ...input.registeredSources },
    acquisition_requests: Object.fromEntries(Object.entries(input.acquisitionRequests).map(
      ([bindingId, request]) => [bindingId, {
        provider_id: request.provider_id,
        parameters: { ...request.parameters },
      }],
    )),
  });
}

export type CoreProductProfileScaffold = Readonly<{
  schema_version: "1.0";
  profile_ref: string;
  dataset_family: string;
  projection: Projection;
  family_spec: Omit<FamilySpec, "canonical_digest">;
  transform_output_tables: readonly { table_id: string; schema_ref: string }[];
  agent_supplied_fields: typeof AGENT_SUPPLIED_FIELDS;
}>;

/**
 * Return the complete Core-owned semantic topology. The caller may bind
 * sources and supply extraction code, but cannot add, remove, rename, or
 * re-role product tables and relations.
 */
export function coreProductProfileScaffold(profileRef: string): CoreProductProfileScaffold {
  const item = resolveCoreProductProfileDescriptor(profileRef);
  const outputs = item.projection.primary_tables
    .concat(item.projection.supporting_tables, item.projection.derived_tables)
    .map((tableId) => {
      const definition = item.tables.find((candidate) => candidate.table_id === tableId);
      if (definition === undefined) throw new Error(`Core product scaffold is missing '${tableId}'`);
      return { table_id: tableId, schema_ref: definition.schema_ref };
    });
  const familySpec: Omit<FamilySpec, "canonical_digest"> = {
    family_spec_id: item.familyId,
    semantic_version: "1.0.0",
    projections: [structuredClone(item.projection)],
    table_definitions: item.tables.map((table) => structuredClone(table)),
    relations: item.relations.map((relation) => structuredClone(relation)),
    identity: {
      dataset_id_scheme: "ds_hash",
      dataset_revision_id_scheme: "dsrev_hash",
      asset_id_scheme: "asset_sha256",
      sample_identity_fields: ["dataset_revision_id", "source_asset_id"],
      probe_mapping_assertion_pk: "mapping_assertion_id",
    },
    transform_capability_refs: [],
    declared_outputs: outputs.map((output) => ({ ...output })),
    integration_policy_ref: `${item.familyId}.integration.v1`,
    validation_policy_ref: item.projection.validation_policy_ref,
    assessment_policy_ref: profileRef,
    resource_class_request: "small",
    scope: "task",
    author: "dataset_core",
    evidence_refs: [],
  };
  return Object.freeze({
    schema_version: "1.0",
    profile_ref: profileRef,
    dataset_family: item.familyId,
    projection: structuredClone(item.projection),
    family_spec: familySpec,
    transform_output_tables: Object.freeze(outputs),
    agent_supplied_fields: AGENT_SUPPLIED_FIELDS,
  });
}
