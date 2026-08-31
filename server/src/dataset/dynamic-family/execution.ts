import { createHash } from "node:crypto";

import {
  buildTransformDescriptorDigestCanonical,
  computeImplementationDigest,
  stableStringify,
  verifyFamilySpecDigest,
  type FamilySpec,
  type ImplementationDigestInput,
  type Projection,
  type TransformDescriptorDigestInput,
} from "@biomed/contracts";

import {
  materializeDynamicFamilyCandidate,
  type DynamicFamilyMaterialization,
} from "./index.js";
import { admitInProcessUnisolatedResult } from "../operation-result-admission/index.js";
import type { ExpectedOperationAdmission } from "../operation-result-admission/types.js";
import {
  compileTransformInProcessUnisolated,
  createInProcessDatasetTransform,
  type FixtureTransformDescriptorMetadata,
} from "../transform-host/admission.js";
import {
  type CoreAuthoritativeTransformContext,
  type CoreAuthorityClaim,
} from "../transform-host/authority.js";
import { TransformBundleStore } from "../transform-host/bundle-store.js";
import {
  InProcessUnisolatedTransformHost,
  type InProcessUnisolatedInputBytes,
} from "../transform-host/in-process-unisolated.js";
import type {
  ExpectedTransformCancelFence,
  ExpectedTransformInvocation,
} from "../transform-admission/types.js";

export interface ExecuteDynamicFamilyTransformInput {
  readonly familySpec: FamilySpec;
  readonly projection: Projection;
  readonly transformSource: string;
  readonly transformMetadata: FixtureTransformDescriptorMetadata;
  readonly expectedInvocation: ExpectedTransformInvocation;
  readonly authorityContext: CoreAuthoritativeTransformContext;
  readonly inputs: readonly Readonly<InProcessUnisolatedInputBytes>[];
  /**
   * ALL formally verified source asset IDs (transform inputs plus
   * provenance-only bindings). This is the explicit Core expected-operation
   * formal dependency input: the admitted OperationResult's
   * ``dependency_closure.input_asset_ids`` closes over exactly this list,
   * while ``expectedInvocation.input_asset_receipts`` and the runtime inputs
   * stay transform_input-only. Output locators must remain a subset.
   */
  readonly formalInputAssetIds: readonly string[];
  readonly bundleRoot: string;
  readonly coreCommitParent: string;
  readonly readCurrentCancelFence: () => ExpectedTransformCancelFence | Promise<ExpectedTransformCancelFence>;
  readonly resolveCommittedRoot: (committedRootRef: string) => string | Promise<string>;
  readonly isGenerationCurrent: (generation: number, cancelFence: string) => boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface ExecuteDynamicFamilyTransformResult {
  readonly receipt: Awaited<ReturnType<InProcessUnisolatedTransformHost["execute"]>>["receipt"];
  readonly operationResult: Awaited<ReturnType<typeof admitInProcessUnisolatedResult>>;
  readonly materialization: DynamicFamilyMaterialization;
}

/**
 * Core-only composition of the explicitly unisolated dynamic execution path.
 * It is not a sandbox or security boundary and never grants publication authority.
 */
export async function executeDynamicFamilyTransform(
  input: ExecuteDynamicFamilyTransformInput,
): Promise<ExecuteDynamicFamilyTransformResult> {
  const expected = input.expectedInvocation;
  const context = input.authorityContext;
  if (!(await verifyFamilySpecDigest(input.familySpec))) {
    throw new TypeError("Dynamic FamilySpec canonical digest is invalid");
  }
  if (input.familySpec.canonical_digest !== expected.family_spec.canonical_digest) {
    throw new TypeError("Dynamic FamilySpec does not match the Core expected invocation");
  }
  if (stableStringify(input.projection) !== stableStringify(
    input.familySpec.projections.find((value) => value.projection_id === input.projection.projection_id),
  )) {
    throw new TypeError("Dynamic projection is not the exact FamilySpec projection");
  }

  if (
    expected.backend_policy.execution_backend !== "in_process_unisolated"
    || expected.cancel_fence.cancellation_state !== "none"
  ) {
    throw new TypeError("Dynamic execution requires the explicit unisolated backend and an open cancel fence");
  }
  const compiled = await compileTransformInProcessUnisolated({ source: input.transformSource });
  const implementation = implementationInput(compiled);
  const implementationDigest = await computeImplementationDigest(implementation);
  if (
    stableStringify(implementation) !== stableStringify(expected.implementation)
    || implementationDigest !== expected.transform_descriptor.implementation_digest
  ) {
    throw new TypeError("Host compilation does not match the Core implementation closure");
  }
  const descriptor = createInProcessDatasetTransform(input.transformMetadata, compiled);
  const descriptorInput: TransformDescriptorDigestInput = {
    ...expected.transform_descriptor,
    implementation_digest: implementationDigest,
  };
  const descriptorDigest = sha256(buildTransformDescriptorDigestCanonical(descriptorInput));
  assertDescriptorClosure(descriptor, expected.transform_descriptor);
  assertAuthorityClosure(context, expected, compiled, descriptorDigest, implementationDigest);

  const store = new TransformBundleStore({ root: input.bundleRoot, authorityContext: context });
  const claim: CoreAuthorityClaim = Object.freeze({
    authorizationToken: context.authorizationToken,
    taskId: context.taskId,
    generation: context.generation,
  });
  try {
    await store.initialize();
    const bundle = await store.put(claim, compiled);
    const host = new InProcessUnisolatedTransformHost({
      explicitlyEnabled: true,
      bundleStore: store,
      authorityContext: context,
      hostImplementationDigest: implementationDigest,
      now: input.now,
    });
    const runtime = await host.execute({
      authorityClaim: claim,
      bundle,
      inputs: input.inputs,
      signal: input.signal,
      isGenerationCurrent: input.isGenerationCurrent,
    });
    const expectedOperation = operationExpectation(input, runtime);
    const operationResult = await admitInProcessUnisolatedResult({
      result: runtime,
      expected_invocation: expected,
      expected_operation: expectedOperation,
      core_commit_parent: input.coreCommitParent,
      read_current_cancel_fence: input.readCurrentCancelFence,
      resolve_committed_root: input.resolveCommittedRoot,
      now: input.now,
    });
    const tableOutputs = Object.fromEntries(input.projection.primary_tables
      .concat(input.projection.supporting_tables, input.projection.derived_tables)
      .map((tableId) => [tableId, {
        data: operationResult,
        provenance: [],
        confidence: [],
        audit: [],
      }]));
    const materialization = await materializeDynamicFamilyCandidate({
      taskId: context.taskId,
      requirementId: context.requirementId,
      familySpec: input.familySpec,
      projection: input.projection,
      tableOutputs,
    });
    return { receipt: runtime.receipt, operationResult, materialization };
  } finally {
    await store.dispose();
  }
}

function implementationInput(compiled: Awaited<ReturnType<typeof compileTransformInProcessUnisolated>>): ImplementationDigestInput {
  return {
    normalized_source_sha256: compiled.sourceDigest,
    emitted_bundle_sha256: compiled.bundleDigest,
    compiler_id: compiled.compilerId,
    compiler_version: compiled.compilerVersion,
    compiler_options_digest: compiled.compilerOptionsDigest,
    dependency_closure_digest: compiled.dependencyClosureDigest,
    runtime_abi_version: compiled.runtimeAbiVersion,
    host_policy_version: compiled.policyDigest,
  };
}

function assertDescriptorClosure(
  descriptor: ReturnType<typeof createInProcessDatasetTransform>,
  expected: TransformDescriptorDigestInput,
): void {
  const actual = {
    transform_id: descriptor.transform_id,
    version: descriptor.version,
    entrypoint: descriptor.entrypoint,
    bound_family_spec_digest: descriptor.bound_family_spec_digest,
    bound_projection_digest: descriptor.bound_projection_digest,
    declared_input_roles: descriptor.declared_input_roles,
    declared_output_tables: descriptor.declared_output_tables,
  };
  const required = {
    transform_id: expected.transform_id,
    version: expected.version,
    entrypoint: expected.entrypoint,
    bound_family_spec_digest: expected.bound_family_spec_digest,
    bound_projection_digest: expected.bound_projection_digest,
    declared_input_roles: expected.declared_input_roles,
    declared_output_tables: expected.declared_output_tables,
  };
  if (stableStringify(actual) !== stableStringify(required)) {
    throw new TypeError("Host transform descriptor metadata does not match Core expectation");
  }
}

function assertAuthorityClosure(
  context: CoreAuthoritativeTransformContext,
  expected: ExpectedTransformInvocation,
  compiled: Awaited<ReturnType<typeof compileTransformInProcessUnisolated>>,
  descriptorDigest: string,
  implementationDigest: string,
): void {
  const mismatched =
    context.taskId !== expected.task_id
    || context.runId !== expected.run_id
    || context.requirementId !== expected.requirement_id
    || context.invocationId !== expected.invocation_id
    || context.attempt !== expected.attempt
    || context.generation !== expected.generation
    || context.requestDigest !== expected.request_digest
    || context.parametersDigest !== expected.parameters_digest
    || context.familySpecDigest !== expected.family_spec.canonical_digest
    || context.projectionDigest !== expected.projection_digest
    || expected.transform_descriptor.bound_family_spec_digest !== expected.family_spec.canonical_digest
    || expected.transform_descriptor.bound_projection_digest !== expected.projection_digest
    || context.transformDescriptorDigest !== descriptorDigest
    || context.implementationDigest !== implementationDigest
    || context.bundleDigest !== compiled.bundleDigest
    || context.codeBundleRef !== compiled.codeBundleRef
    || context.compilerDigest !== expected.compiler_digest
    || context.runtimeDigest !== expected.runtime_digest
    || context.policyDigest !== expected.backend_policy.policy_digest
    || stableStringify(context.resourceLimits) !== stableStringify(expected.backend_policy.resource_limits)
    || context.deadline !== expected.deadline_fence.deadline_at;
  if (mismatched) throw new TypeError("Core authority context does not match expected transform invocation");
}

function operationExpectation(
  input: ExecuteDynamicFamilyTransformInput,
  runtime: Awaited<ReturnType<InProcessUnisolatedTransformHost["execute"]>>,
): ExpectedOperationAdmission {
  const context = input.authorityContext;
  const expected = input.expectedInvocation;
  const tableById = new Map(input.familySpec.table_definitions.map((table) => [table.table_id, table]));
  const receipts = runtime.receipt.quarantined_output_receipts;
  const tables = Object.fromEntries(receipts.map((receipt) => {
    const definition = tableById.get(receipt.table_id);
    if (definition === undefined) throw new TypeError(`Runtime emitted undeclared table '${receipt.table_id}'`);
    return [receipt.table_id, {
      table_id: receipt.table_id,
      dataset_family: input.familySpec.family_spec_id,
      row_granularity: input.projection.row_granularity,
      schema_ref: receipt.schema_ref,
      row_count: receipt.row_count,
      column_count: definition.field_names.length,
      primary_file_sha256: receipt.sha256,
    }];
  }));
  if (Object.keys(tables).length !== receipts.length) {
    throw new TypeError("Runtime emitted duplicate table identifiers");
  }
  // The operation admission closure is the formal source dependency closure:
  // ALL verified source assets (transform inputs plus provenance-only
  // bindings), independent of the transform runtime's exact input receipts.
  // Admission validates that output locators stay a subset of this closure,
  // and the runtime locators are transform-input-only by construction.
  const formalInputAssetIds = [...input.formalInputAssetIds].sort();
  const operationIdentity = sha256(`${context.invocationId}\0${context.attempt}`).slice(0, 24);
  return {
    task_id: context.taskId,
    run_id: context.runId,
    requirement_id: context.requirementId,
    attempt: context.attempt,
    generation: context.generation,
    expected_exit_state: "succeeded",
    operation_id: `integrate_${operationIdentity}`,
    operation_attempt_id: `attempt_${operationIdentity}`,
    operation_kind: "integrate",
    output_kind: "integrated_table",
    output_summary: { tables },
    input_digest: context.requestDigest,
    parameter_digest: context.parametersDigest,
    implementation_digest: context.implementationDigest,
    input_asset_ids: formalInputAssetIds,
    upstream_result_manifest_ids: expected.input_result_receipts.map((receipt) => receipt.result_manifest_id),
    declared_schemas: expected.expected_outputs.map((output) => output.schema_ref),
    declared_locators: runtimeOutputLocatorClosure(receipts),
    committed_at: input.now?.().toISOString(),
  };
}

export function expectedOutputLocatorClosure(
  outputs: ExpectedTransformInvocation["expected_outputs"],
): string[] {
  return [...new Set(outputs.map((output) => output.locator_ref))];
}

export function runtimeOutputLocatorClosure(
  outputs: readonly { readonly locator_ref: string }[],
): string[] {
  return [...new Set(outputs.map((output) => output.locator_ref))];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
