import {
  computeDynamicFamilyPreflightReceiptDigest,
  parseDynamicFamilyPreflightReceipt,
  type DynamicFamilyPreflightAcquisitionPlanEntry,
  type DynamicFamilyPreflightReceipt,
  type DynamicFamilyPreflightTopologyDiagnostic,
  type JsonValue,
  type RuntimeLimits,
} from "@biomed/contracts";

import type { ParsedDynamicFamilyBuildSubmission } from "../../agent/tools/dynamic-family-build.js";
import { canonicalDigest } from "../adapters/identity.js";
import type { CoreAcquisitionPlan } from "../acquisition/runtime.js";
import { parseWorkflowRecipeRef } from "../contracts/acquisition.js";
import { checkFamilySpecTopology } from "../family-spec-topology/index.js";
import { materializeDynamicFamilySchemas } from "./index.js";
import { prepareDynamicFamilyHostDescriptor } from "./submission.js";

type Binding = ParsedDynamicFamilyBuildSubmission["build_proposal"]["source_bindings"][number];
type AcquisitionRequest = ParsedDynamicFamilyBuildSubmission["acquisition_requests"][string];

export interface DynamicFamilyAcquisitionPlanningInput {
  readonly binding: Binding;
  readonly request: AcquisitionRequest;
}

export interface PrepareDynamicFamilyBuildInput {
  readonly taskId: string;
  readonly buildId: string;
  readonly generation: number;
  readonly submission: ParsedDynamicFamilyBuildSubmission;
  readonly runtimeLimits?: RuntimeLimits;
  /** Provider planning only; this callback must not acquire or register bytes. */
  readonly planAcquisition?: (input: DynamicFamilyAcquisitionPlanningInput) => Promise<CoreAcquisitionPlan>;
}

export interface ValidateDynamicFamilyPreflightInput {
  readonly receipt: unknown;
  readonly submission: ParsedDynamicFamilyBuildSubmission;
  readonly taskId: string;
  readonly buildId: string;
  readonly generation: number;
  readonly runtimeLimits?: RuntimeLimits;
  /** Reuse the same cheap Core provider planning seam used by preparation. */
  readonly planAcquisition?: PrepareDynamicFamilyBuildInput["planAcquisition"];
}

function diagnosticFacts(
  issues: readonly ReturnType<typeof checkFamilySpecTopology>["issues"][number][],
): DynamicFamilyPreflightTopologyDiagnostic[] {
  return issues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    message: issue.message,
    object_id: issue.object_id ?? null,
  }));
}

function selectedOutputClosure(submission: ParsedDynamicFamilyBuildSubmission): string[] {
  const projection = submission.projection;
  return [
    ...projection.primary_tables,
    ...projection.supporting_tables,
    ...projection.derived_tables,
  ];
}

function requiredInputRoles(submission: ParsedDynamicFamilyBuildSubmission): string[] {
  const bindings = submission.build_proposal.source_bindings;
  const declared = submission.transform_metadata.declared_input_roles;
  if (bindings.length === 0) throw new TypeError("dynamic preflight requires at least one input binding");
  if (bindings.length !== declared.length) {
    throw new TypeError("dynamic preflight input roles do not close build source bindings");
  }
  const roles = bindings.map((binding, index) => {
    const role = declared[index]?.role;
    if (role !== binding.input_requirement_ref) {
      throw new TypeError(
        `dynamic preflight input role mismatch for binding '${binding.binding_id}': expected '${binding.input_requirement_ref}', received '${role ?? "missing"}'`,
      );
    }
    return binding.input_requirement_ref;
  });
  if (new Set(roles).size !== roles.length) {
    throw new TypeError("dynamic preflight input roles must be unique");
  }
  return roles;
}

function assertDeclaredOutputClosure(submission: ParsedDynamicFamilyBuildSubmission): void {
  const expected = selectedOutputClosure(submission);
  const declared = submission.transform_metadata.declared_output_tables;
  if (declared.length !== expected.length || declared.some((table, index) => table.table_id !== expected[index])) {
    throw new TypeError("dynamic preflight transform output tables do not close the selected projection");
  }
  const definitions = new Map(
    submission.family_spec.table_definitions.map((table) => [table.table_id, table.schema_ref]),
  );
  for (const table of declared) {
    if (definitions.get(table.table_id) !== table.schema_ref) {
      throw new TypeError(`dynamic preflight output schema does not match table '${table.table_id}'`);
    }
  }
}

function logicalSubmissionDigestInput(submission: ParsedDynamicFamilyBuildSubmission): JsonValue {
  const proposal = submission.build_proposal;
  return {
    schema_version: submission.schema_version,
    execution_backend: submission.execution_backend,
    family_spec_digest: submission.family_spec.canonical_digest,
    projection_id: submission.projection.projection_id,
    transform_source: submission.transform_source,
    transform_metadata: submission.transform_metadata as unknown as JsonValue,
    build_proposal: {
      ...proposal,
      // The Host descriptor digest is deliberately the prepared fact. The
      // submitter binds its proposal reference to this receipt fact.
      transform_refs: proposal.transform_refs.map((ref) => ({
        scope: ref.scope,
        id: ref.id,
        version: ref.version,
      })),
    } as unknown as JsonValue,
    registered_sources: submission.registered_sources as unknown as JsonValue,
    acquisition_requests: submission.acquisition_requests as unknown as JsonValue,
  };
}

export function dynamicFamilyPreflightSubmissionDigest(
  submission: ParsedDynamicFamilyBuildSubmission,
): string {
  return canonicalDigest(logicalSubmissionDigestInput(submission));
}

function planRequestDigest(input: {
  readonly binding: Binding;
  readonly mode: "registered" | "builtin";
  readonly assetId: string | null;
  readonly request: AcquisitionRequest | null;
}): string {
  return canonicalDigest({
    binding_id: input.binding.binding_id,
    source: input.binding.source,
    input_requirement_ref: input.binding.input_requirement_ref,
    parameters: input.binding.parameters,
    mode: input.mode,
    asset_id: input.assetId,
    provider_id: input.request?.provider_id ?? null,
    acquisition_parameters: input.request?.parameters ?? null,
  });
}

function parseCoreAcquisitionPlan(
  value: unknown,
  request: AcquisitionRequest,
  binding: Binding,
): CoreAcquisitionPlan {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`dynamic preflight Core acquisition plan is missing for binding '${binding.binding_id}'`);
  }
  const record = value as Record<string, unknown>;
  const requestIdentityDigest = record.requestIdentityDigest;
  const providerId = record.providerId;
  const implementationDigest = record.implementationDigest;
  let recipe: CoreAcquisitionPlan["recipe"] = null;
  if (record.recipe !== null) {
    try {
      recipe = parseWorkflowRecipeRef(record.recipe);
    } catch {
      throw new TypeError(`dynamic preflight Core acquisition plan is malformed for binding '${binding.binding_id}'`);
    }
  }
  if (
    typeof requestIdentityDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(requestIdentityDigest)
    || typeof providerId !== "string"
    || providerId !== request.provider_id
    || typeof implementationDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(implementationDigest)
  ) {
    throw new TypeError(`dynamic preflight Core acquisition plan is malformed for binding '${binding.binding_id}'`);
  }
  return {
    requestIdentityDigest,
    providerId,
    implementationDigest,
    recipe,
  };
}

async function acquisitionPlan(
  input: PrepareDynamicFamilyBuildInput,
): Promise<DynamicFamilyPreflightAcquisitionPlanEntry[]> {
  const result: DynamicFamilyPreflightAcquisitionPlanEntry[] = [];
  for (const binding of input.submission.build_proposal.source_bindings) {
    const registeredAsset = input.submission.registered_sources[binding.binding_id];
    if (registeredAsset !== undefined) {
      result.push({
        binding_id: binding.binding_id,
        input_requirement_ref: binding.input_requirement_ref,
        source: binding.source,
        mode: "registered",
        asset_id: registeredAsset,
        provider_id: null,
        request_digest: planRequestDigest({
          binding,
          mode: "registered",
          assetId: registeredAsset,
          request: null,
        }),
      });
      continue;
    }
    const request = input.submission.acquisition_requests[binding.binding_id];
    if (request === undefined) {
      throw new TypeError(`dynamic preflight has no acquisition plan for binding '${binding.binding_id}'`);
    }
    if (input.planAcquisition === undefined) {
      throw new TypeError(`dynamic preflight Core acquisition plan is missing for binding '${binding.binding_id}'`);
    }
    const planned = parseCoreAcquisitionPlan(
      await input.planAcquisition({ binding, request }),
      request,
      binding,
    );
    result.push({
      binding_id: binding.binding_id,
      input_requirement_ref: binding.input_requirement_ref,
      source: binding.source,
      mode: "builtin",
      asset_id: null,
      provider_id: request.provider_id,
      request_digest: planned.requestIdentityDigest,
    });
  }
  return result;
}

function freezeReceipt(receipt: DynamicFamilyPreflightReceipt): DynamicFamilyPreflightReceipt {
  for (const diagnostic of receipt.topology_diagnostics) Object.freeze(diagnostic);
  for (const plan of receipt.acquisition_plan) Object.freeze(plan);
  Object.freeze(receipt.required_input_roles);
  Object.freeze(receipt.output_closure);
  Object.freeze(receipt.topology_diagnostics);
  Object.freeze(receipt.acquisition_plan);
  return Object.freeze(receipt);
}

/**
 * Deterministic, side-effect-free structural preflight. No SourceAsset bytes,
 * OperationResult, assessment, publication, or artifact are touched here.
 */
export async function prepareDynamicFamilyBuild(
  input: PrepareDynamicFamilyBuildInput,
): Promise<DynamicFamilyPreflightReceipt> {
  if (input.submission.build_proposal.build_id !== input.buildId) {
    throw new TypeError("dynamic preflight build_id does not match the Core build context");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new TypeError("dynamic preflight generation must be a non-negative safe integer");
  }
  const topology = checkFamilySpecTopology(input.submission.family_spec);
  if (!topology.topology_valid) {
    const diagnostics = diagnosticFacts(topology.issues);
    const detail = diagnostics.map((issue) => `${issue.code}@${issue.path}: ${issue.message}`).join("; ");
    throw new TypeError(`dynamic preflight topology diagnostics: ${detail}`);
  }
  await materializeDynamicFamilySchemas(input.submission.family_spec, input.submission.projection);
  const roles = requiredInputRoles(input.submission);
  assertDeclaredOutputClosure(input.submission);
  const descriptor = await prepareDynamicFamilyHostDescriptor({
    submission: input.submission,
    runtimeLimits: input.runtimeLimits,
  });
  const acquisition = await acquisitionPlan(input);
  const unsigned: DynamicFamilyPreflightReceipt = {
    schema_version: "1.0",
    task_id: input.taskId,
    build_id: input.buildId,
    generation: input.generation,
    family_spec_digest: input.submission.family_spec.canonical_digest,
    projection_digest: descriptor.projectionDigest,
    host_descriptor_digest: descriptor.transformDescriptorDigest,
    submission_digest: dynamicFamilyPreflightSubmissionDigest(input.submission),
    required_input_roles: roles,
    output_closure: selectedOutputClosure(input.submission),
    topology_diagnostics: diagnosticFacts(topology.issues),
    acquisition_plan: acquisition,
    receipt_digest: "0".repeat(64),
  };
  const receiptDigest = await computeDynamicFamilyPreflightReceiptDigest(unsigned);
  return freezeReceipt({ ...unsigned, receipt_digest: receiptDigest });
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Validate the receipt before any acquisition, byte resolution, or transform execution. */
export async function validateDynamicFamilyPreflightReceipt(
  input: ValidateDynamicFamilyPreflightInput,
): Promise<DynamicFamilyPreflightReceipt> {
  const receipt = parseDynamicFamilyPreflightReceipt(input.receipt, "$preflight_receipt");
  const expectedReceiptDigest = await computeDynamicFamilyPreflightReceiptDigest(receipt);
  if (receipt.receipt_digest !== expectedReceiptDigest) {
    throw new TypeError("dynamic preflight receipt digest is tampered or invalid");
  }
  if (receipt.task_id !== input.taskId) {
    throw new TypeError("dynamic preflight receipt is cross-task");
  }
  if (receipt.build_id !== input.buildId) {
    throw new TypeError("dynamic preflight receipt is cross-build");
  }
  if (receipt.generation !== input.generation) {
    throw new TypeError("dynamic preflight receipt has stale generation");
  }
  const expected = await prepareDynamicFamilyBuild({
    taskId: input.taskId,
    buildId: input.buildId,
    generation: input.generation,
    submission: input.submission,
    runtimeLimits: input.runtimeLimits,
    planAcquisition: input.planAcquisition,
  });
  if (receipt.family_spec_digest !== expected.family_spec_digest) {
    throw new TypeError("dynamic preflight FamilySpec digest drifted");
  }
  if (receipt.projection_digest !== expected.projection_digest) {
    throw new TypeError("dynamic preflight projection digest drifted");
  }
  if (receipt.host_descriptor_digest !== expected.host_descriptor_digest) {
    throw new TypeError("dynamic preflight Host descriptor digest drifted");
  }
  if (receipt.submission_digest !== expected.submission_digest) {
    throw new TypeError("dynamic preflight submission digest drifted");
  }
  if (!equalJson(receipt.required_input_roles, expected.required_input_roles)) {
    throw new TypeError("dynamic preflight required input roles do not match");
  }
  if (!equalJson(receipt.output_closure, expected.output_closure)) {
    throw new TypeError("dynamic preflight output closure does not match");
  }
  if (!equalJson(receipt.topology_diagnostics, expected.topology_diagnostics)) {
    throw new TypeError("dynamic preflight topology diagnostics drifted");
  }
  if (!equalJson(receipt.acquisition_plan, expected.acquisition_plan)) {
    throw new TypeError("dynamic preflight acquisition plan does not match");
  }
  const transformRef = input.submission.build_proposal.transform_refs[0];
  if (transformRef === undefined || transformRef.digest !== receipt.host_descriptor_digest) {
    throw new TypeError("dynamic preflight submit must present the prepared Host descriptor digest");
  }
  return receipt;
}
