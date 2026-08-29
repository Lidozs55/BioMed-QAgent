import { types } from "node:util";

import {
  assertJsonValue,
  computeFamilySpecDigest,
  parseDynamicFamilyPreflightReceipt,
  parseDatasetExecutionProposal2,
  parseDatasetTransform,
  parseFamilySpec,
  type DatasetExecutionProposal2,
  type DynamicFamilyPreflightReceipt,
  type DatasetTransform,
  type FamilySpec,
  type Projection,
} from "@biomed/contracts";

import { canonicalDigest } from "../../dataset/adapters/identity.js";
import { DYNAMIC_ACQUISITION_PROVIDER_DESCRIPTORS } from "../../dataset/acquisition/provider-catalog.js";
import type {
  BioMedAgentTool,
  BioMedToolExecutionContext,
  BioMedToolResult,
} from "../contracts.js";

const TOP_KEYS = new Set([
  "schema_version",
  "execution_backend",
  "family_spec",
  "projection_id",
  "transform_source",
  "transform_metadata",
  "execution_proposal",
  "registered_sources",
  "acquisition_requests",
]);
const MAX_SOURCE_BYTES = 256 * 1024;
const HEX = "0".repeat(64);

type DataRecord = Record<string, unknown>;

export interface ParsedDynamicFamilyPublicationSubmission {
  readonly schema_version: "1.0";
  readonly execution_backend: "in_process_unisolated";
  readonly family_spec: FamilySpec;
  readonly projection: Projection;
  readonly transform_source: string;
  readonly transform_metadata: Omit<DatasetTransform,
    | "source_digest" | "bundle_digest" | "compiler_id" | "compiler_version"
    | "compiler_options_digest" | "runtime_abi_version" | "runtime_policy_version"
    | "dependency_closure_digest" | "code_bundle_ref">;
  readonly execution_proposal: DatasetExecutionProposal2;
  readonly registered_sources: Readonly<Record<string, string>>;
  readonly acquisition_requests: Readonly<Record<string, {
    readonly provider_id: string;
    readonly parameters: Readonly<Record<string, import("@biomed/contracts").JsonValue>>;
  }>>;
}

export interface DynamicFamilyPublicationToolOptions {
  readonly submit: (
    submission: ParsedDynamicFamilyPublicationSubmission,
    signal: AbortSignal | undefined,
    context: BioMedToolExecutionContext | undefined,
    preflightReceipt: DynamicFamilyPreflightReceipt,
  ) => Promise<unknown>;
  /**
   * Resolves the server-side prepared submission for receipt-only submit.
   * When absent, receipt-only requests are rejected with an explicit error and
   * callers must re-echo the full prepared_submission.
   */
  readonly resolveSubmission?: (
    preflightReceipt: DynamicFamilyPreflightReceipt,
  ) => Promise<ParsedDynamicFamilyPublicationSubmission>;
}

export interface PrepareDynamicFamilyPublicationToolOptions {
  readonly prepare: (
    submission: ParsedDynamicFamilyPublicationSubmission,
    signal: AbortSignal | undefined,
    context: BioMedToolExecutionContext | undefined,
  ) => Promise<DynamicFamilyPreflightReceipt>;
}

/**
 * Preserve structured per-binding diagnostics (CoreAcquisitionError and any
 * wrapped error carrying `details`/`retryable`) alongside the message, so a
 * failed submit reports which binding/provider/host failed instead of only
 * the aggregate message.
 */
function structuredError(error: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (error !== null && typeof error === "object") {
    if ("retryable" in error && typeof error.retryable === "boolean") body.retryable = error.retryable;
    const details = (error as { details?: unknown }).details;
    if (details !== null && typeof details === "object" && !Array.isArray(details)) {
      body.acquisition = details;
    }
  }
  return body;
}

export function createDynamicFamilyPublicationTool(
  options: DynamicFamilyPublicationToolOptions,
): BioMedAgentTool {
  return {
    name: "submit_dynamic_family_publication",
    label: "Submit Dynamic Family Publication",
    description:
      "Submit a prepared Dynamic Family publication. Preferred wire: pass schema_version plus the unchanged preflight_receipt returned by prepare_dynamic_family_publication — the server resolves the stored prepared submission, so no payload re-echo is needed. Re-echoing the full prepared_submission together with the receipt is still accepted. Use only providers reported in inspect_dataset_execution_routes.dynamic.direct_bindings; the acquisition_requests schema is the execution contract, not proof of semantic or publication closure. This is not a sandbox, isolation mechanism, or security boundary. Direct paths and discovery bytes are forbidden.",
    parameters: dynamicFamilyPublicationParameters("submit"),
    async execute(value, signal, context): Promise<BioMedToolResult> {
      try {
        const parsed = await parseDynamicFamilyPublicationSubmitRequest(value);
        let submission = parsed.submission;
        if (submission === null) {
          if (options.resolveSubmission === undefined) {
            throw new Error(
              "receipt-only submit is not available for this task; re-echo the full prepared_submission with the preflight_receipt",
            );
          }
          submission = await options.resolveSubmission(parsed.preflightReceipt);
        }
        const details = await options.submit(submission, signal, context, parsed.preflightReceipt);
        return { content: JSON.stringify(details), details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorBody = { code: "dynamic_publication_rejected", message, ...structuredError(error) };
        return {
          content: JSON.stringify({ ok: false, error: errorBody }),
          details: { ok: false, error: errorBody },
          isError: true,
        };
      }
    },
  };
}

export function createPrepareDynamicFamilyPublicationTool(
  options: PrepareDynamicFamilyPublicationToolOptions,
): BioMedAgentTool {
  return {
    name: "prepare_dynamic_family_publication",
    label: "Prepare Dynamic Family Publication",
    description:
      "Use after inspect_dataset_execution_routes when no registered static family expresses the required topology and every input is dynamic-bindable or a prior task-owned Core asset. Do not prevalidate a dynamic FamilySpec with validate_dataset_execution. Submit semantic fields without derived digest properties. This deterministic, side-effect-free preflight derives all digest bindings, validates topology and acquisition planning, and returns prepared_submission plus a task/requirement/generation-bound preflight_receipt; pass both unchanged to submit_dynamic_family_publication. Top-level keys, exactly: schema_version, execution_backend, family_spec, projection_id, transform_source, transform_metadata, registered_sources, acquisition_requests, execution_proposal.",
    parameters: dynamicFamilyPublicationParameters("prepare"),
    async execute(value, signal, context): Promise<BioMedToolResult> {
      try {
        const submission = await parseDynamicFamilyPublicationPrepareSubmission(value);
        const receipt = await options.prepare(submission, signal, context);
        const preparedSubmission = dynamicFamilyPublicationWire(
          submission,
          receipt.host_descriptor_digest,
        );
        const details = {
          ok: true,
          status: "prepared",
          prepared_submission: preparedSubmission,
          preflight_receipt: receipt,
        };
        return { content: JSON.stringify(details), details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: JSON.stringify({ ok: false, error: { code: "dynamic_preflight_rejected", message } }),
          details: { ok: false, error: { code: "dynamic_preflight_rejected", message } },
          isError: true,
        };
      }
    },
  };
}

export function createDynamicFamilyPublicationTools(options: {
  readonly prepare: PrepareDynamicFamilyPublicationToolOptions["prepare"];
  readonly submit: DynamicFamilyPublicationToolOptions["submit"];
}): readonly [BioMedAgentTool, BioMedAgentTool] {
  return [
    createPrepareDynamicFamilyPublicationTool({ prepare: options.prepare }),
    createDynamicFamilyPublicationTool({ submit: options.submit }),
  ];
}

function dynamicFamilyPublicationParameters(mode: "prepare" | "submit"): Record<string, unknown> {
  const includeDerivedBindings = mode === "submit";
  const digest = { type: "string", pattern: "^[0-9a-f]{64}$" };
  const safeId = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$" };
  const ids = { type: "array", items: safeId, maxItems: 128 };
  const scope = { type: "string", enum: ["task", "user", "curated", "system"] };
  const scopeRef = {
    type: "object",
    properties: { scope, id: safeId, version: safeId, digest },
    required: ["scope", "id", "version", "digest"],
    additionalProperties: false,
  };
  const projection = {
    type: "object",
    properties: {
      projection_id: safeId,
      schema_version: { type: "string", enum: ["2.0"] },
      primary_tables: ids, supporting_tables: ids, derived_tables: ids,
      required: ids, optional: ids, allow_empty: ids, relations: ids,
      row_granularity: {
        ...safeId,
        description: "Machine identifier, not prose; for bioactivity use activity_measurement.",
      },
      compatibility_dimensions: ids, merge_identity_fields: ids,
      validation_policy_ref: safeId, assessment_policy_ref: safeId,
    },
    required: [
      "projection_id", "schema_version", "primary_tables", "supporting_tables",
      "derived_tables", "required", "optional", "allow_empty", "relations",
      "row_granularity", "compatibility_dimensions", "merge_identity_fields",
      "validation_policy_ref", "assessment_policy_ref",
    ],
    additionalProperties: false,
  };
  const tableDefinition = {
    type: "object",
    properties: {
      table_id: safeId, schema_ref: safeId,
      role: { type: "string", enum: ["primary", "supporting", "derived"] },
      required: { type: "boolean" }, allow_empty: { type: "boolean" },
      primary_key: ids, field_names: ids,
    },
    required: ["table_id", "schema_ref", "role", "required", "allow_empty", "primary_key", "field_names"],
    additionalProperties: false,
  };
  const relation = {
    type: "object",
    properties: {
      relation_id: safeId, from_table_id: safeId, from_fields: ids,
      to_table_id: safeId, to_fields: ids,
      cardinality: { type: "string", enum: ["one_to_one", "one_to_many", "many_to_one", "many_to_many"] },
      missing_policy: { type: "string", enum: ["reject", "allow_empty", "allow_missing", "profile_defined"] },
    },
    required: ["relation_id", "from_table_id", "from_fields", "to_table_id", "to_fields", "cardinality", "missing_policy"],
    additionalProperties: false,
  };
  const declaredTable = {
    type: "object",
    properties: { table_id: safeId, schema_ref: safeId },
    required: ["table_id", "schema_ref"],
    additionalProperties: false,
  };
  const familySpec = {
    type: "object",
    description: includeDerivedBindings
      ? "Declarative topology bound to its server-derived canonical digest."
      : "Declarative topology only. Omit canonical_digest; prepare_dynamic_family_publication derives and binds it.",
    properties: {
      family_spec_id: safeId, semantic_version: safeId,
      ...(includeDerivedBindings ? { canonical_digest: digest } : {}),
      projections: { type: "array", minItems: 1, items: projection },
      table_definitions: { type: "array", minItems: 1, items: tableDefinition },
      relations: { type: "array", items: relation },
      identity: {
        type: "object",
        properties: {
          dataset_id_scheme: { type: "string", enum: ["ds_hash"] },
          dataset_revision_id_scheme: { type: "string", enum: ["dsrev_hash"] },
          asset_id_scheme: { type: "string", enum: ["asset_sha256"] },
          sample_identity_fields: ids, probe_mapping_assertion_pk: safeId,
        },
        required: ["dataset_id_scheme", "dataset_revision_id_scheme", "asset_id_scheme", "sample_identity_fields", "probe_mapping_assertion_pk"],
        additionalProperties: false,
      },
      transform_capability_refs: ids,
      declared_outputs: { type: "array", minItems: 1, items: declaredTable },
      integration_policy_ref: safeId, validation_policy_ref: safeId,
      assessment_policy_ref: safeId, resource_class_request: safeId,
      scope, author: { type: "string", minLength: 1 }, evidence_refs: ids,
    },
    required: [
      "family_spec_id", "semantic_version",
      ...(includeDerivedBindings ? ["canonical_digest"] : []), "projections",
      "table_definitions", "relations", "identity", "transform_capability_refs",
      "declared_outputs", "integration_policy_ref", "validation_policy_ref",
      "assessment_policy_ref", "resource_class_request", "scope", "author", "evidence_refs",
    ],
    additionalProperties: false,
  };
  const transformMetadata = {
    type: "object",
    description: "Metadata for a TypeScript module exporting transform.run({inputs}); inputs are frozen UTF-8 registered bytes and outputs use out_0, out_1, ... in projection order.",
    properties: {
      transform_id: safeId, version: safeId, entrypoint: { type: "string", enum: ["transform.run"] },
      declared_input_roles: {
        type: "array", minItems: 1, items: {
          type: "object",
          properties: {
            role: safeId, media_type: { type: "string", minLength: 1 },
            constraint_ref: { anyOf: [safeId, { type: "null" }] },
          },
          required: ["role", "media_type", "constraint_ref"], additionalProperties: false,
        },
      },
      declared_output_tables: { type: "array", minItems: 1, items: declaredTable },
      ...(includeDerivedBindings
        ? { bound_family_spec_digest: digest, bound_projection_digest: digest }
        : {}),
      determinism_profile: { type: "string", enum: ["deterministic", "non_deterministic"] },
      resource_class: safeId, origin: safeId, scope,
      review_refs: ids,
    },
    required: [
      "transform_id", "version", "entrypoint", "declared_input_roles",
      "declared_output_tables",
      ...(includeDerivedBindings
        ? ["bound_family_spec_digest", "bound_projection_digest"]
        : []),
      "determinism_profile", "resource_class", "origin", "scope", "review_refs",
    ],
    additionalProperties: false,
  };
  const proposalBinding = {
    type: "object",
    properties: {
      binding_id: safeId, source: safeId, input_requirement_ref: safeId,
      parameters: { type: "object" },
    },
    required: ["binding_id", "source", "input_requirement_ref", "parameters"],
    additionalProperties: false,
  };
  const buildProposal = {
    type: "object",
    properties: {
      schema_version: { type: "string", enum: ["2.0"] },
      spec_kind: { type: "string", enum: ["proposal"] },
      requirement_id: safeId,
      family_spec_ref: includeDerivedBindings ? scopeRef : {
        type: "object",
        properties: { scope, id: safeId, version: safeId },
        required: ["scope", "id", "version"],
        additionalProperties: false,
      },
      projection_ref: safeId,
      source_bindings: { type: "array", minItems: 1, items: proposalBinding },
      transform_refs: {
        type: "array", minItems: 1, maxItems: 1,
        items: includeDerivedBindings ? scopeRef : {
          type: "object",
          properties: { scope, id: safeId, version: safeId },
          required: ["scope", "id", "version"],
          additionalProperties: false,
        },
      },
      policy_refs: { type: "array", items: scopeRef },
      output_format: safeId, idempotency_identity: safeId,
    },
    required: [
      "schema_version", "spec_kind", "requirement_id", "family_spec_ref", "projection_ref",
      "source_bindings", "transform_refs", "policy_refs", "output_format", "idempotency_identity",
    ],
    additionalProperties: false,
  };
  const fixedParameters = (sourceName: string, accessionDescription: string) => ({
    type: "object",
    properties: {
      source: { type: "string", enum: [sourceName] },
      accession: { anyOf: [{ type: "string", description: accessionDescription }, { type: "null" }] },
      entities: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
    },
    required: ["source", "accession", "entities"], additionalProperties: false,
  });
  const pubmedParameters = {
    type: "object",
    description: "One PMCID per binding. This Core provider retrieves Europe PMC full-text XML only; it does not formalize browser, PDF, VLM, or workspace outputs.",
    properties: {
      source: { type: "string", enum: ["pubmed"] },
      accession: { type: "string", pattern: "^PMC[1-9][0-9]*$" },
      entities: { type: "object", properties: {}, additionalProperties: false },
    },
    required: ["source", "accession", "entities"], additionalProperties: false,
  };
  const pubchemParameters = {
    type: "object",
    description: "Exactly one CID per binding. For multiple compounds create multiple source bindings/acquisition requests.",
    properties: {
      source: { type: "string", enum: ["pubchem"] },
      accession: { type: "string", pattern: "^[1-9][0-9]*$" },
      entities: {
        type: "object",
        properties: {
          pubchem_cids: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", pattern: "^[1-9][0-9]*$" } },
          compound_ids: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", pattern: "^[1-9][0-9]*$" } },
        },
        additionalProperties: false,
      },
    },
    required: ["source", "accession", "entities"], additionalProperties: false,
  };
  const acquisition = {
    type: "object",
    oneOf: DYNAMIC_ACQUISITION_PROVIDER_DESCRIPTORS.map((descriptor) => {
      const parameters = descriptor.parameterContract === "pubchem"
        ? pubchemParameters
        : descriptor.parameterContract === "pubmed"
          ? pubmedParameters
          : fixedParameters(descriptor.source, descriptor.inputHint);
      return {
        properties: {
          provider_id: { type: "string", enum: [descriptor.providerId] },
          parameters,
        },
        required: ["provider_id", "parameters"], additionalProperties: false,
      };
    }),
  };
  const preflightReceipt = {
    type: "object",
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      task_id: safeId,
      requirement_id: safeId,
      generation: { type: "integer", minimum: 0 },
      family_spec_digest: digest,
      projection_digest: digest,
      host_descriptor_digest: digest,
      submission_digest: digest,
      required_input_roles: ids,
      output_closure: ids,
      topology_diagnostics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: safeId,
            path: { type: "string", minLength: 1 },
            message: { type: "string", minLength: 1 },
            object_id: { anyOf: [safeId, { type: "null" }] },
          },
          required: ["code", "path", "message", "object_id"],
          additionalProperties: false,
        },
      },
      acquisition_plan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            binding_id: safeId,
            input_requirement_ref: safeId,
            source: safeId,
            mode: { type: "string", enum: ["registered", "builtin"] },
            asset_id: { anyOf: [{ type: "string", pattern: "^asset_[0-9a-f]{64}$" }, { type: "null" }] },
            provider_id: { anyOf: [safeId, { type: "null" }] },
            request_digest: digest,
          },
          required: ["binding_id", "input_requirement_ref", "source", "mode", "asset_id", "provider_id", "request_digest"],
          additionalProperties: false,
        },
      },
      receipt_digest: digest,
    },
    required: [
      "schema_version", "task_id", "requirement_id", "generation", "family_spec_digest", "projection_digest",
      "host_descriptor_digest", "submission_digest", "required_input_roles", "output_closure",
      "topology_diagnostics", "acquisition_plan", "receipt_digest",
    ],
    additionalProperties: false,
  };
  const schema: Record<string, unknown> = {
    type: "object",
    properties: {
      schema_version: { type: "string", enum: ["1.0"] },
      execution_backend: { type: "string", enum: ["in_process_unisolated"] },
      family_spec: {
        ...familySpec,
        description:
          `For normalized bioactivity use exactly target_records, compound_records, assay_records, activity_records (primary), and compound_crosswalk; activity_records has many-to-one relations to target_records, compound_records, and assay_records. ${includeDerivedBindings ? "Use only the prepared server-bound digest values." : "Omit all derived digest properties; prepare_dynamic_family_publication computes and returns them in prepared_submission."}`,
      },
      projection_id: safeId,
      transform_source: {
        type: "string", minLength: 1, maxLength: MAX_SOURCE_BYTES,
        description: "Synchronous TypeScript only (not Python, not async/Promise). Export const transform={run({inputs}){...}}. Inputs are ordered exactly like execution_proposal.source_bindings and are named in_0, in_1, ... (not binding IDs); each frozen input is {handle,receipt_kind,receipt_id,text}. Use array destructuring (const [first,...rest]=inputs), forEach/map/find/shift, dot properties, and named regex groups. EVERY bracket element access is forbidden, including inputs[0], lines[i], match[1], object['key'], and dynamic keys. Do not import or use process/require/globalThis/eval, input.text(), filesystem, or network. Return exactly {outputs:[...]} and no other top-level keys. Every outputs entry is a wire envelope, NOT a rows object: exactly {content:'complete CSV text including header',handle:'out_0',locator_ref:first.receipt_id,row_count:<data rows>,schema_ref:'<declared schema>',table_id:'<declared table>'}. Use out_0, out_1, ... in primary+supporting+derived projection order. locator_ref must be non-empty and may use the same first.receipt_id for every table derived from that source.",
      },
      transform_metadata: transformMetadata,
      execution_proposal: buildProposal,
      registered_sources: {
        type: "object", description: "Usually {}. Only Core-acquired asset IDs are accepted.",
        additionalProperties: { type: "string", pattern: "^asset_[0-9a-f]{64}$" },
      },
      acquisition_requests: {
        type: "object", description: "Preferred formal input path. Every provider listed here is runtime-wired for Dynamic Family acquisition; absence means unavailable through this route. Keys exactly match unresolved execution_proposal source binding IDs. Create one binding/request per formal carrier.",
        additionalProperties: acquisition,
      },
    },
    additionalProperties: false,
  };
  if (mode === "submit") {
    const properties = schema.properties as Record<string, unknown>;
    properties.preflight_receipt = preflightReceipt;
    // Receipt-only submit is the preferred wire: the payload fields stay
    // optional and the server resolves the stored prepared submission.
    schema.required = ["schema_version", "preflight_receipt"];
  }
  return schema;
}

const FAMILY_SPEC_DRAFT_KEYS = new Set([
  "family_spec_id", "semantic_version", "projections", "table_definitions",
  "relations", "identity", "transform_capability_refs", "declared_outputs",
  "integration_policy_ref", "validation_policy_ref", "assessment_policy_ref",
  "resource_class_request", "scope", "author", "evidence_refs",
]);
const TRANSFORM_METADATA_DRAFT_KEYS = new Set([
  "transform_id", "version", "entrypoint", "declared_input_roles",
  "declared_output_tables", "determinism_profile", "resource_class", "origin",
  "scope", "review_refs",
]);
const EXECUTION_PROPOSAL_KEYS = new Set([
  "schema_version", "spec_kind", "requirement_id", "family_spec_ref",
  "projection_ref", "source_bindings", "transform_refs", "policy_refs",
  "output_format", "idempotency_identity",
]);
const UNDIGESTED_SCOPE_REF_KEYS = new Set(["scope", "id", "version"]);

/**
 * Prepare accepts only semantic facts. The server derives every digest that is
 * a pure function of those facts, while submit keeps the existing strict wire.
 */
export async function parseDynamicFamilyPublicationPrepareSubmission(
  value: unknown,
): Promise<ParsedDynamicFamilyPublicationSubmission> {
  const record = exactDataRecord(value, TOP_KEYS, "$dynamic_family_publication_prepare");
  if (types.isProxy(record.family_spec)) {
    throw new TypeError("$.family_spec must be a non-Proxy object");
  }
  if (
    record.family_spec !== null
    && typeof record.family_spec === "object"
    && Object.hasOwn(record.family_spec, "canonical_digest")
  ) {
    // Persisted sessions may still carry the previous prepare schema. Keep the
    // old strict request valid while advertising only the server-derived draft.
    return parseDynamicFamilyPublicationSubmission(value);
  }
  const familyDraft = exactDataRecord(
    record.family_spec,
    FAMILY_SPEC_DRAFT_KEYS,
    "$.family_spec",
  );
  const familySeed = parseFamilySpec({
    ...familyDraft,
    canonical_digest: HEX,
  }, "$.family_spec");
  const familyDigest = await computeFamilySpecDigest(familySeed);
  const familySpec = { ...familyDraft, canonical_digest: familyDigest };
  const parsedFamily = parseFamilySpec(familySpec, "$.family_spec");
  if (typeof record.projection_id !== "string") throw new TypeError("projection_id must be a string");
  const projection = parsedFamily.projections.find(
    (item) => item.projection_id === record.projection_id,
  );
  if (projection === undefined) {
    throw new TypeError(`unknown FamilySpec projection '${record.projection_id}'`);
  }

  const metadataDraft = exactDataRecord(
    record.transform_metadata,
    TRANSFORM_METADATA_DRAFT_KEYS,
    "$.transform_metadata",
  );
  const proposalDraft = exactDataRecord(
    record.execution_proposal,
    EXECUTION_PROPOSAL_KEYS,
    "$.execution_proposal",
  );
  const familyRef = exactDataRecord(
    proposalDraft.family_spec_ref,
    UNDIGESTED_SCOPE_REF_KEYS,
    "$.execution_proposal.family_spec_ref",
  );
  const transformRefs = exactDataArray(
    proposalDraft.transform_refs,
    "$.execution_proposal.transform_refs",
  );
  if (transformRefs.length !== 1) {
    throw new TypeError("execution_proposal.transform_refs must contain exactly one transform");
  }
  const transformRef = exactDataRecord(
    transformRefs[0],
    UNDIGESTED_SCOPE_REF_KEYS,
    "$.execution_proposal.transform_refs[0]",
  );
  const projectionDigestValue = projectionDigest(projection);
  return parseDynamicFamilyPublicationSubmission({
    ...record,
    family_spec: familySpec,
    transform_metadata: {
      ...metadataDraft,
      bound_family_spec_digest: familyDigest,
      bound_projection_digest: projectionDigestValue,
    },
    execution_proposal: {
      ...proposalDraft,
      family_spec_ref: { ...familyRef, digest: familyDigest },
      transform_refs: [{ ...transformRef, digest: HEX }],
    },
  });
}

export function dynamicFamilyPublicationWire(
  submission: ParsedDynamicFamilyPublicationSubmission,
  hostDescriptorDigest: string,
): Record<string, unknown> {
  return {
    schema_version: submission.schema_version,
    execution_backend: submission.execution_backend,
    family_spec: submission.family_spec,
    projection_id: submission.projection.projection_id,
    transform_source: submission.transform_source,
    transform_metadata: submission.transform_metadata,
    execution_proposal: {
      ...submission.execution_proposal,
      transform_refs: submission.execution_proposal.transform_refs.map((ref) => ({
        ...ref,
        digest: hostDescriptorDigest,
      })),
    },
    registered_sources: submission.registered_sources,
    acquisition_requests: submission.acquisition_requests,
  };
}

/** Strict wire boundary only. It never executes code or grants publication authority. */
export async function parseDynamicFamilyPublicationSubmission(
  value: unknown,
): Promise<ParsedDynamicFamilyPublicationSubmission> {
  const record = exactDataRecord(value, TOP_KEYS, "$dynamic_family_publication");
  if (record.schema_version !== "1.0") throw new TypeError("dynamic family publication schema_version must be 1.0");
  if (record.execution_backend !== "in_process_unisolated") {
    throw new TypeError("dynamic family publications require the explicit in_process_unisolated backend");
  }
  const family = parseFamilySpec(record.family_spec, "$.family_spec");
  if (family.scope === "example") throw new TypeError("example FamilySpec cannot execute");
  const expectedFamilyDigest = await computeFamilySpecDigest(family);
  if (family.canonical_digest !== expectedFamilyDigest) {
    throw new TypeError(`FamilySpec canonical_digest must equal ${expectedFamilyDigest}`);
  }
  if (typeof record.projection_id !== "string") throw new TypeError("projection_id must be a string");
  const projection = family.projections.find((item) => item.projection_id === record.projection_id);
  if (projection === undefined) throw new TypeError(`unknown FamilySpec projection '${record.projection_id}'`);
  const source = sourceText(record.transform_source);
  const transform = parseMetadata(record.transform_metadata);
  const expectedProjectionDigest = projectionDigest(projection);
  if (
    transform.scope === "example"
    || transform.bound_family_spec_digest !== family.canonical_digest
    || transform.bound_projection_digest !== expectedProjectionDigest
  ) {
    throw new TypeError(
      `transform metadata must bind family ${family.canonical_digest} and projection ${expectedProjectionDigest}`,
    );
  }
  const proposal = parseDatasetExecutionProposal2(record.execution_proposal, "$.execution_proposal");
  const registeredSources = parseRegisteredSources(record.registered_sources, proposal);
  const acquisitionRequests = parseAcquisitionRequests(record.acquisition_requests, proposal);
  assertSourceClosure(proposal, registeredSources, acquisitionRequests);
  if (
    proposal.family_spec_ref.id !== family.family_spec_id
    || proposal.family_spec_ref.version !== family.semantic_version
    || proposal.family_spec_ref.digest !== family.canonical_digest
    || proposal.family_spec_ref.scope !== family.scope
    || proposal.projection_ref !== projection.projection_id
  ) {
    throw new TypeError("execution proposal does not bind the exact FamilySpec projection");
  }
  return Object.freeze({
    schema_version: "1.0",
    execution_backend: "in_process_unisolated",
    family_spec: family,
    projection,
    transform_source: source,
    transform_metadata: transform,
    execution_proposal: proposal,
    registered_sources: registeredSources,
    acquisition_requests: acquisitionRequests,
  });
}

export interface ParsedDynamicFamilyPublicationSubmitRequest {
  /** null for receipt-only submit; the runtime resolves the stored submission. */
  readonly submission: ParsedDynamicFamilyPublicationSubmission | null;
  readonly preflightReceipt: DynamicFamilyPreflightReceipt;
}

/**
 * Strict submit wire parser; production callers must present the receipt.
 * Accepts the receipt-only minimal wire ({ schema_version, preflight_receipt }),
 * in which case ``submission`` is null and the caller resolves the stored
 * prepared submission from the task-scoped preflight store.
 */
export async function parseDynamicFamilyPublicationSubmitRequest(
  value: unknown,
): Promise<ParsedDynamicFamilyPublicationSubmitRequest> {
  const label = "$dynamic_family_publication_submit";
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value)) {
    const ownKeys = new Set(
      Reflect.ownKeys(value).filter((key): key is string => typeof key === "string"),
    );
    if (ownKeys.has("preflight_receipt") && !ownKeys.has("family_spec")) {
      const allowed = new Set(["schema_version", "preflight_receipt"]);
      const unexpected = [...ownKeys].filter((key) => !allowed.has(key));
      if (unexpected.length > 0) {
        throw new TypeError(
          `${label} receipt-only submit accepts schema_version and preflight_receipt only; unexpected keys: ${unexpected.join(", ")}`,
        );
      }
      const record = exactDataRecord(value, allowed, label);
      const preflightReceipt = parseDynamicFamilyPreflightReceipt(record.preflight_receipt, "$.preflight_receipt");
      return Object.freeze({ submission: null, preflightReceipt });
    }
  }
  const record = exactDataRecord(value, new Set([...TOP_KEYS, "preflight_receipt"]), label);
  if (!Object.hasOwn(record, "preflight_receipt")) {
    throw new TypeError("submit_dynamic_family_publication requires preflight_receipt from prepare_dynamic_family_publication");
  }
  const base = Object.create(null) as DataRecord;
  for (const key of TOP_KEYS) base[key] = record[key];
  const submission = await parseDynamicFamilyPublicationSubmission(base);
  const preflightReceipt = parseDynamicFamilyPreflightReceipt(record.preflight_receipt, "$.preflight_receipt");
  return Object.freeze({ submission, preflightReceipt });
}

function parseRegisteredSources(
  value: unknown,
  proposal: DatasetExecutionProposal2,
): Readonly<Record<string, string>> {
  const bindingIds = new Set(proposal.source_bindings.map((binding) => binding.binding_id));
  const record = subsetDataRecord(value, bindingIds, "$.registered_sources");
  const result = Object.create(null) as Record<string, string>;
  for (const [bindingId, assetId] of Object.entries(record)) {
    if (typeof assetId !== "string" || !/^asset_[0-9a-f]{64}$/.test(assetId)) {
      throw new TypeError(`registered_sources.${bindingId} must be a task-owned asset_<sha256> ID`);
    }
    result[bindingId] = assetId;
  }
  return Object.freeze(result);
}

function parseAcquisitionRequests(
  value: unknown,
  proposal: DatasetExecutionProposal2,
): ParsedDynamicFamilyPublicationSubmission["acquisition_requests"] {
  const bindingIds = new Set(proposal.source_bindings.map((binding) => binding.binding_id));
  const record = subsetDataRecord(value, bindingIds, "$.acquisition_requests");
  const result = Object.create(null) as Record<string, { provider_id: string; parameters: Readonly<Record<string, import("@biomed/contracts").JsonValue>> }>;
  for (const [bindingId, raw] of Object.entries(record)) {
    const request = exactDataRecord(raw, new Set(["provider_id", "parameters"]), `$.acquisition_requests.${bindingId}`);
    if (typeof request.provider_id !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(request.provider_id)) {
      throw new TypeError(`acquisition_requests.${bindingId}.provider_id is invalid`);
    }
    const parameters = assertJsonValue(
      request.parameters,
      `$.acquisition_requests.${bindingId}.parameters`,
    );
    if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
      throw new TypeError(`acquisition_requests.${bindingId}.parameters must be a JSON object`);
    }
    result[bindingId] = Object.freeze({
      provider_id: request.provider_id,
      parameters: Object.freeze(parameters),
    });
  }
  return Object.freeze(result);
}

function assertSourceClosure(
  proposal: DatasetExecutionProposal2,
  registered: Readonly<Record<string, string>>,
  acquisitions: ParsedDynamicFamilyPublicationSubmission["acquisition_requests"],
): void {
  const expected = proposal.source_bindings.map((binding) => binding.binding_id).sort();
  const actual = [...Object.keys(registered), ...Object.keys(acquisitions)].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new TypeError("registered_sources and acquisition_requests must form one disjoint exact binding closure");
  }
}

function parseMetadata(value: unknown): ParsedDynamicFamilyPublicationSubmission["transform_metadata"] {
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
    const presentStrings = new Set(ownKeys.filter((key): key is string => typeof key === "string"));
    const missing = [...keys].filter((key) => !presentStrings.has(key));
    const unexpected = ownKeys.filter((key) => typeof key !== "string" || !keys.has(key)).map(String);
    throw new TypeError(
      `${label} has unknown or missing fields (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
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

function exactDataArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(`${label} must be a non-Proxy array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
  ) {
    throw new TypeError(`${label}.length must be a data property`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).length !== result.length + 1) {
    throw new TypeError(`${label} has unknown fields`);
  }
  return result;
}

function subsetDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string> | null,
  label: string,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(`${label} must be a plain non-Proxy object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must have a plain prototype`);
  const result = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys !== null && !allowedKeys.has(key))) {
      throw new TypeError(`${label} has an unknown field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
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
