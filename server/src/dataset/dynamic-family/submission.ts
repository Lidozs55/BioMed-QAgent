import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  buildTransformDescriptorDigestCanonical,
  computeImplementationDigest,
  type InputAssetReceipt,
  type ResourceLimits,
  type RuntimeLimits,
  type SourceLocatorV2,
  type TransformDescriptorDigestInput,
} from "@biomed/contracts";

import type { ParsedDynamicFamilyBuildSubmission } from "../../agent/tools/dynamic-family-build.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
import { canonicalDigest } from "../adapters/identity.js";
import {
  compileTransformInProcessUnisolated,
} from "../transform-host/admission.js";
import type { CoreAuthoritativeTransformContext } from "../transform-host/authority.js";
import type { InProcessUnisolatedInputBytes } from "../transform-host/in-process-unisolated.js";
import type { ExpectedTransformInvocation } from "../transform-admission/types.js";
import {
  executeDynamicFamilyTransform,
  type ExecuteDynamicFamilyTransformResult,
} from "./execution.js";

export interface SubmitDynamicFamilyBuildInput {
  readonly taskId: string;
  readonly runId: string;
  readonly submission: ParsedDynamicFamilyBuildSubmission;
  readonly sourceAssetRegistry: SourceAssetRegistry;
  readonly taskRoot: string;
  readonly runtimeLimits: RuntimeLimits;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/**
 * Resolves only task-owned registered assets and issues the Core capability for
 * the explicit in-process unisolated runtime. This is not a sandbox, isolation
 * mechanism, or security boundary, and this function does not publish.
 */
export async function submitDynamicFamilyBuild(
  input: SubmitDynamicFamilyBuildInput,
): Promise<ExecuteDynamicFamilyTransformResult> {
  const now = input.now ?? (() => new Date());
  const proposal = input.submission.build_proposal;
  const projection = input.submission.projection;
  const bindings = proposal.source_bindings;
  if (bindings.length === 0) throw new TypeError("dynamic transform requires at least one registered input");
  if (bindings.length !== input.submission.transform_metadata.declared_input_roles.length) {
    throw new TypeError("transform declared input roles do not close build source bindings");
  }

  const assetReceipts: InputAssetReceipt[] = [];
  const sourceLocators: SourceLocatorV2[] = [];
  const runtimeInputs: Readonly<InProcessUnisolatedInputBytes>[] = [];
  for (const [index, binding] of bindings.entries()) {
    const declared = input.submission.transform_metadata.declared_input_roles[index]!;
    if (declared.role !== binding.input_requirement_ref) {
      throw new TypeError(`transform input role does not match binding '${binding.binding_id}'`);
    }
    const assetId = input.submission.registered_sources[binding.binding_id]!;
    const resolved = await input.sourceAssetRegistry.resolveAny(assetId);
    const bytes = await collectBytes(resolved.content, 512 * 1024 * 1024);
    const registration = resolved.registration_receipt;
    const receipt = Object.freeze({
      asset_id: registration.asset_ref.asset_id,
      role: binding.input_requirement_ref,
      sha256: registration.sha256,
      size_bytes: registration.size_bytes,
      locator_ref: registration.asset_ref.asset_id,
    });
    const handle = Object.freeze({
      handle: `in_${index}`,
      receiptKind: "asset" as const,
      receiptId: receipt.asset_id,
    });
    assetReceipts.push(receipt);
    sourceLocators.push({
      locator_version: "2.0",
      locator_type: "json_pointer",
      asset_id: receipt.asset_id,
      logical_file: registration.relative_path,
      raw_value: receipt.sha256,
      json_pointer: "",
    });
    runtimeInputs.push(Object.freeze({ ...handle, bytes }));
  }

  const compiled = await compileTransformInProcessUnisolated({
    source: input.submission.transform_source,
  });
  const implementation = {
    normalized_source_sha256: compiled.sourceDigest,
    emitted_bundle_sha256: compiled.bundleDigest,
    compiler_id: compiled.compilerId,
    compiler_version: compiled.compilerVersion,
    compiler_options_digest: compiled.compilerOptionsDigest,
    dependency_closure_digest: compiled.dependencyClosureDigest,
    runtime_abi_version: compiled.runtimeAbiVersion,
    host_policy_version: compiled.policyDigest,
  };
  const implementationDigest = await computeImplementationDigest(implementation);
  const projectionDigest = canonicalDigest(projection);
  const runtimeDigest = canonicalDigest({
    runtime_abi_version: compiled.runtimeAbiVersion,
    runtime_policy_version: compiled.policyVersion,
  });
  const resourceLimits = resourceLimitsFor(input.runtimeLimits);
  const resourcePolicyDigest = canonicalDigest({ resource_class: input.submission.transform_metadata.resource_class, resource_limits: resourceLimits });
  const descriptorInput: TransformDescriptorDigestInput = {
    transform_id: input.submission.transform_metadata.transform_id,
    version: input.submission.transform_metadata.version,
    entrypoint: input.submission.transform_metadata.entrypoint,
    implementation_digest: implementationDigest,
    bound_family_spec_digest: input.submission.family_spec.canonical_digest,
    bound_projection_digest: projectionDigest,
    declared_input_roles: [...input.submission.transform_metadata.declared_input_roles],
    declared_output_tables: [...input.submission.transform_metadata.declared_output_tables],
    runtime_policy_digest: runtimeDigest,
    import_policy_digest: compiled.policyDigest,
    resource_policy_digest: resourcePolicyDigest,
  };
  const transformDescriptorDigest = sha256(buildTransformDescriptorDigestCanonical(descriptorInput));
  const transformRefs = proposal.transform_refs;
  if (
    transformRefs.length !== 1
    || transformRefs[0]!.scope !== input.submission.transform_metadata.scope
    || transformRefs[0]!.id !== input.submission.transform_metadata.transform_id
    || transformRefs[0]!.version !== input.submission.transform_metadata.version
    || transformRefs[0]!.digest !== transformDescriptorDigest
  ) {
    throw new TypeError(
      `build proposal transform_ref must bind the Host-compiled descriptor ${transformDescriptorDigest}`,
    );
  }
  const invocationId = `dynamic_${sha256(`${input.taskId}\0${input.runId}\0${proposal.build_id}`).slice(0, 24)}`;
  const outputTables = [
    ...projection.primary_tables,
    ...projection.supporting_tables,
    ...projection.derived_tables,
  ];
  const outputHandles = outputTables.map((_, index) => `out_${index}`);
  const inputLocatorRefs = assetReceipts.map((receipt) => receipt.locator_ref);
  const tableById = new Map(input.submission.family_spec.table_definitions.map((table) => [table.table_id, table]));
  const expectedOutputs = outputTables.map((tableId, index) => {
    const definition = tableById.get(tableId);
    if (definition === undefined) throw new TypeError(`projection references unknown table '${tableId}'`);
    return {
      table_id: tableId,
      schema_ref: definition.schema_ref,
      artifact_ref: `transform-host://${invocationId}/output/${outputHandles[index]}`,
      locator_ref: inputLocatorRefs[0]!,
      relative_path: `tables/${tableId}.csv`,
      delimiter: "," as const,
      header: [...definition.field_names],
      source_locators: sourceLocators,
    };
  });
  const requestDigest = canonicalDigest({ proposal, registered_sources: input.submission.registered_sources });
  const parametersDigest = canonicalDigest(bindings.map((binding) => binding.parameters));
  const deadline = new Date(now().getTime() + resourceLimits.wall_ms).toISOString();
  const sandboxConfigDigest = sha256(JSON.stringify({
    backend: "in_process_unisolated",
    policyVersion: compiled.policyVersion,
    securityBoundary: false,
  }));
  const expectedInvocation: ExpectedTransformInvocation = {
    owner: "dataset_core",
    task_id: input.taskId,
    run_id: input.runId,
    build_id: proposal.build_id,
    invocation_id: invocationId,
    attempt: 1,
    generation: 0,
    request_digest: requestDigest,
    parameters_digest: parametersDigest,
    family_spec: input.submission.family_spec,
    projection_digest: projectionDigest,
    transform_descriptor: descriptorInput,
    transform_descriptor_digest: transformDescriptorDigest,
    implementation,
    implementation_digest: implementationDigest,
    compiler_digest: compiled.compilerDigest,
    runtime_digest: runtimeDigest,
    input_asset_receipts: assetReceipts,
    input_result_receipts: [],
    backend_policy: {
      sandbox_backend: "in_process_unisolated",
      sandbox_config_digest: sandboxConfigDigest,
      policy_digest: compiled.policyDigest,
      granted_capabilities: ["bounded_log", "bounded_output"],
      resource_limits: resourceLimits,
    },
    expected_outputs: expectedOutputs,
    deadline_fence: { deadline_at: deadline },
    cancel_fence: { cancellation_state: "none", cancel_requested_at: null },
  };
  const authorizationToken = Object.freeze({});
  const inputHandles = runtimeInputs.map((runtimeInput) => Object.freeze({
    handle: runtimeInput.handle,
    receiptKind: runtimeInput.receiptKind,
    receiptId: runtimeInput.receiptId,
  }));
  const context: CoreAuthoritativeTransformContext = Object.freeze({
    authorizationToken,
    taskId: input.taskId,
    runId: input.runId,
    buildId: proposal.build_id,
    invocationId,
    attempt: 1,
    generation: 0,
    requestDigest,
    parametersDigest,
    familySpecDigest: input.submission.family_spec.canonical_digest,
    projectionDigest,
    transformDescriptorDigest,
    implementationDigest,
    bundleDigest: compiled.bundleDigest,
    codeBundleRef: compiled.codeBundleRef,
    compilerDigest: compiled.compilerDigest,
    runtimeDigest,
    policyDigest: compiled.policyDigest,
    resourceClassId: input.submission.transform_metadata.resource_class,
    resourceLimits,
    deadline,
    cancelFence: `fence_${sha256(invocationId).slice(0, 24)}`,
    inputHandles: Object.freeze(inputHandles),
    outputHandles: Object.freeze(outputHandles),
    inputAssetReceipts: Object.freeze(assetReceipts),
    inputResultReceipts: Object.freeze([]),
  });
  const coreCommitParent = path.join(input.taskRoot, "builds", proposal.build_id, "dynamic-results");
  await mkdir(coreCommitParent, { recursive: true });
  return executeDynamicFamilyTransform({
    familySpec: input.submission.family_spec,
    projection,
    transformSource: input.submission.transform_source,
    transformMetadata: input.submission.transform_metadata,
    expectedInvocation,
    authorityContext: context,
    inputs: Object.freeze(runtimeInputs),
    bundleRoot: path.join(input.taskRoot, "state", "dynamic-transform-bundles"),
    coreCommitParent,
    readCurrentCancelFence: () => expectedInvocation.cancel_fence,
    resolveCommittedRoot: (rootRef) => path.join(coreCommitParent, rootRef),
    isGenerationCurrent: (generation, cancelFence) =>
      generation === context.generation && cancelFence === context.cancelFence && !input.signal?.aborted,
    signal: input.signal,
    now,
  });
}

function resourceLimitsFor(limits: RuntimeLimits): Readonly<ResourceLimits> {
  const wall = limits.dataset_operation_timeout_seconds * 1_000;
  return Object.freeze({
    wall_ms: wall,
    cpu_ms: wall,
    rss_bytes: 512 * 1024 * 1024,
    temp_bytes: 512 * 1024 * 1024,
    output_bytes: 256 * 1024 * 1024,
    log_bytes: limits.command_output_kib * 1024,
    open_files: 32,
    pids: 1,
  });
}

async function collectBytes(source: AsyncIterable<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > maximum) throw new TypeError("registered dynamic input exceeds the Core byte limit");
    chunks.push(Uint8Array.from(chunk));
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
