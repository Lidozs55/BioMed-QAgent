import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildTransformDescriptorDigestCanonical,
  computeImplementationDigest,
  DEFAULT_RUNTIME_LIMITS,
  type DynamicFamilyPreflightReceipt,
  type InputAssetReceipt,
  type OperationResultManifest,
  type ResourceLimits,
  type RuntimeLimits,
  type SourceLocatorV2,
  type TransformDescriptorDigestInput,
} from "@biomed/contracts";

import type { ParsedDynamicFamilyPublicationSubmission } from "../../agent/tools/dynamic-family-publication.js";
import type { CoreAcquisitionPlan } from "../acquisition/runtime.js";
import type {
  CoreAcquisitionProvenance,
  SourceAssetRegistry,
} from "../../runtime/source-assets/registry.js";
import { canonicalDigest } from "../adapters/identity.js";
import {
  compileTransformInProcessUnisolated,
} from "../transform-host/admission.js";
import type { CoreAuthoritativeTransformContext } from "../transform-host/authority.js";
import type { InProcessUnisolatedInputBytes } from "../transform-host/in-process-unisolated.js";
import type { ExpectedTransformInvocation } from "../transform-admission/types.js";
import { materializeDynamicFamilyCandidate } from "./index.js";
import {
  validateDynamicFamilyPreflightReceipt,
  type DynamicFamilyAcquisitionPlanningInput,
} from "./preflight.js";
import {
  executeDynamicFamilyTransform,
  type ExecuteDynamicFamilyTransformResult,
} from "./execution.js";
import type { CoreProductTopologyRequirements } from "./product-requirements.js";

export interface SubmitDynamicFamilyPublicationInput {
  readonly taskId: string;
  readonly runId: string;
  readonly submission: ParsedDynamicFamilyPublicationSubmission;
  readonly sourceAssetRegistry: SourceAssetRegistry;
  readonly taskRoot: string;
  readonly runtimeLimits: RuntimeLimits;
  /** Core-owned build generation bound by the preflight receipt. */
  readonly generation: number;
  /** Required by the production two-phase path. */
  readonly preflightReceipt: DynamicFamilyPreflightReceipt;
  /** The exact proposal submitted to prepare, before Core resolves acquisitions. */
  readonly preflightSubmission: ParsedDynamicFamilyPublicationSubmission;
  /** Exact Core-owned requested-product topology bound by preflight. */
  readonly productRequirements: CoreProductTopologyRequirements;
  /** Core-only cheap provider planning reused to verify the committed receipt. */
  readonly planAcquisition?: (input: DynamicFamilyAcquisitionPlanningInput) => Promise<CoreAcquisitionPlan>;
  /** Live Core generation fence checked by the Host during execution. */
  readonly isGenerationCurrent?: (generation: number, cancelFence: string) => boolean;
  /** Core-internal exact acquisition identity selection; never accepted from the Agent. */
  readonly sourceAcquisitionRequestDigests?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export type CompiledDynamicFamilyTransform = Awaited<ReturnType<typeof compileTransformInProcessUnisolated>>;

export interface DynamicFamilyHostDescriptorPreparation {
  readonly compiled: CompiledDynamicFamilyTransform;
  readonly implementation: {
    readonly normalized_source_sha256: string;
    readonly emitted_bundle_sha256: string;
    readonly compiler_id: string;
    readonly compiler_version: string;
    readonly compiler_options_digest: string;
    readonly dependency_closure_digest: string;
    readonly runtime_abi_version: string;
    readonly host_policy_version: string;
  };
  readonly implementationDigest: string;
  readonly projectionDigest: string;
  readonly runtimeDigest: string;
  readonly resourceLimits: Readonly<ResourceLimits>;
  readonly resourcePolicyDigest: string;
  readonly descriptorInput: TransformDescriptorDigestInput;
  readonly transformDescriptorDigest: string;
}

/**
 * Compile and digest the exact Host descriptor once for preflight and again
 * before execution. This keeps the receipt on the same admission primitives
 * as the execution path instead of introducing a second descriptor policy.
 */
export async function prepareDynamicFamilyHostDescriptor(input: {
  readonly submission: ParsedDynamicFamilyPublicationSubmission;
  readonly runtimeLimits?: RuntimeLimits;
}): Promise<DynamicFamilyHostDescriptorPreparation> {
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
  } as const;
  const implementationDigest = await computeImplementationDigest(implementation);
  const projectionDigest = canonicalDigest(input.submission.projection);
  const runtimeDigest = canonicalDigest({
    runtime_abi_version: compiled.runtimeAbiVersion,
    runtime_policy_version: compiled.policyVersion,
  });
  const resourceLimits = resourceLimitsFor(input.runtimeLimits ?? DEFAULT_RUNTIME_LIMITS);
  const resourcePolicyDigest = canonicalDigest({
    resource_class: input.submission.transform_metadata.resource_class,
    resource_limits: resourceLimits,
  });
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
  return {
    compiled,
    implementation,
    implementationDigest,
    projectionDigest,
    runtimeDigest,
    resourceLimits,
    resourcePolicyDigest,
    descriptorInput,
    transformDescriptorDigest,
  };
}

/**
 * Resolves only task-owned registered assets and issues the Core capability for
 * the explicit in-process unisolated runtime. This is not a sandbox, isolation
 * mechanism, or security boundary, and this function does not publish.
 */
export interface DynamicFamilyExecutionResult extends ExecuteDynamicFamilyTransformResult {
  /** Core-only root; callers must never expose this path to the Agent. */
  readonly trustedRoot: string;
  readonly sourceAcquisitionProvenance: readonly CoreAcquisitionProvenance[];
}

export async function submitDynamicFamilyPublication(
  input: SubmitDynamicFamilyPublicationInput,
): Promise<DynamicFamilyExecutionResult> {
  const now = input.now ?? (() => new Date());
  if (input.preflightReceipt === undefined) {
    throw new TypeError("dynamic family submit requires a preflight receipt");
  }
  if (input.preflightSubmission === undefined) {
    throw new TypeError("dynamic family submit requires the prepared submission");
  }
  if (input.productRequirements === undefined) {
    throw new TypeError("dynamic family submit requires Core-owned product requirements");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new TypeError("dynamic family submit requires a non-negative generation");
  }
  await validateDynamicFamilyPreflightReceipt({
    receipt: input.preflightReceipt,
    submission: input.preflightSubmission,
    taskId: input.taskId,
    requirementId: input.submission.execution_proposal.requirement_id,
    generation: input.generation,
    runtimeLimits: input.runtimeLimits,
    planAcquisition: input.planAcquisition,
    productRequirements: input.productRequirements,
  });
  const proposal = input.submission.execution_proposal;
  const projection = input.submission.projection;
  const bindings = proposal.source_bindings;
  if (bindings.length === 0) throw new TypeError("dynamic transform requires at least one registered input");
  if (bindings.length !== input.submission.transform_metadata.declared_input_roles.length) {
    throw new TypeError("transform declared input roles do not close execution source bindings");
  }

  const assetReceipts: InputAssetReceipt[] = [];
  const sourceAcquisitionProvenance: CoreAcquisitionProvenance[] = [];
  const sourceLocators: SourceLocatorV2[] = [];
  const runtimeInputs: Readonly<InProcessUnisolatedInputBytes>[] = [];
  for (const [index, binding] of bindings.entries()) {
    const declared = input.submission.transform_metadata.declared_input_roles[index]!;
    if (declared.role !== binding.input_requirement_ref) {
      throw new TypeError(
        `transform input role does not match binding '${binding.binding_id}': expected '${binding.input_requirement_ref}', received '${declared.role}'`,
      );
    }
    const assetId = input.submission.registered_sources[binding.binding_id]!;
    const resolved = await input.sourceAssetRegistry.resolveCoreAcquired(
      assetId,
      input.sourceAcquisitionRequestDigests?.[binding.binding_id],
    );
    const bytes = await collectBytes(resolved.content, 512 * 1024 * 1024);
    const registration = resolved.registration_receipt;
    sourceAcquisitionProvenance.push(resolved.acquisition_provenance);
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

  const descriptor = await prepareDynamicFamilyHostDescriptor({
    submission: input.submission,
    runtimeLimits: input.runtimeLimits,
  });
  const {
    compiled,
    implementation,
    implementationDigest,
    projectionDigest,
    runtimeDigest,
    resourceLimits,
    descriptorInput,
    transformDescriptorDigest,
  } = descriptor;
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
  const generation = input.generation;
  const invocationId = `dynamic_${sha256(`${input.taskId}\0${input.runId}\0${proposal.requirement_id}\0${generation}`).slice(0, 24)}`;
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
    requirement_id: proposal.requirement_id,
    invocation_id: invocationId,
    attempt: 1,
    generation,
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
    requirementId: proposal.requirement_id,
    invocationId,
    attempt: 1,
    generation,
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
  const executionRoot = path.join(input.taskRoot, "dataset_runs", input.runId, proposal.requirement_id);
  const coreCommitParent = path.join(executionRoot, "dynamic-results");
  await mkdir(coreCommitParent, { recursive: true });
  let trustedRoot: string | null = null;
  const result = await executeDynamicFamilyTransform({
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
    resolveCommittedRoot: (rootRef) => {
      trustedRoot = path.join(coreCommitParent, rootRef);
      return trustedRoot;
    },
    isGenerationCurrent: (candidateGeneration, cancelFence) =>
      candidateGeneration === context.generation
      && cancelFence === context.cancelFence
      && !input.signal?.aborted
      && (input.isGenerationCurrent?.(candidateGeneration, cancelFence) ?? true),
    signal: input.signal,
    now,
  });
  if (trustedRoot === null) throw new Error("Core operation admission did not resolve its committed root");
  const evidenceRoot = path.join(executionRoot, "dynamic-evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const selectedTables = [
    ...projection.primary_tables,
    ...projection.supporting_tables,
    ...projection.derived_tables,
  ];
  const tableOutputs = Object.fromEntries(await Promise.all(selectedTables.map(async (tableId) => {
    const provenance = await coreEvidenceResult({
      root: evidenceRoot, kind: "provenance", tableId, taskId: input.taskId,
      runId: input.runId,
      requirementId: proposal.requirement_id, operation: result.operationResult,
      implementationDigest, inputAssetIds: assetReceipts.map((receipt) => receipt.asset_id), now,
    });
    const confidence = await coreEvidenceResult({
      root: evidenceRoot, kind: "confidence", tableId, taskId: input.taskId,
      runId: input.runId,
      requirementId: proposal.requirement_id, operation: result.operationResult,
      implementationDigest, inputAssetIds: assetReceipts.map((receipt) => receipt.asset_id), now,
    });
    return [tableId, { data: result.operationResult, provenance: [provenance], confidence: [confidence], audit: [] }];
  })));
  const materialization = await materializeDynamicFamilyCandidate({
    taskId: input.taskId,
    runId: input.runId,
    requirementId: proposal.requirement_id,
    familySpec: input.submission.family_spec,
    projection,
    tableOutputs,
  });
  return {
    ...result,
    materialization,
    trustedRoot,
    sourceAcquisitionProvenance: Object.freeze(sourceAcquisitionProvenance),
  };
}

async function coreEvidenceResult(input: {
  root: string;
  kind: "provenance" | "confidence";
  tableId: string;
  taskId: string;
  runId: string;
  requirementId: string;
  operation: OperationResultManifest;
  implementationDigest: string;
  inputAssetIds: string[];
  now: () => Date;
}): Promise<OperationResultManifest> {
  const relativePath = `${input.kind}/${input.tableId}.json`;
  const absolutePath = path.join(input.root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const body = `${JSON.stringify({
    schema_version: "1.0",
    evidence_kind: input.kind,
    table_id: input.tableId,
    source_operation_result_manifest_id: input.operation.result_manifest_id,
    registered_asset_ids: input.inputAssetIds,
    confidence: input.kind === "confidence" ? "source_preserved" : undefined,
  })}\n`;
  await writeFile(absolutePath, body, "utf8");
  const digest = sha256(body);
  const size = (await stat(absolutePath)).size;
  const identity = sha256(`${input.kind}\0${input.tableId}\0${input.operation.result_manifest_id}`).slice(0, 24);
  const committedAt = input.now().toISOString();
  return {
    schema_version: "1.0",
    result_manifest_id: `result_${identity}`,
    task_id: input.taskId,
    run_id: input.runId,
    requirement_id: input.requirementId,
    attempt: 1,
    operation_id: `derive_${identity}`,
    operation_attempt_id: `attempt_${identity}`,
    operation_kind: "derive",
    status: "succeeded",
    input_digest: input.operation.output_digest ?? input.operation.input_digest,
    parameter_digest: canonicalDigest({ table_id: input.tableId, evidence_kind: input.kind }),
    implementation_digest: input.implementationDigest,
    output_kind: "derived_evidence",
    output_digest: digest,
    output_summary: { table_id: input.tableId, evidence_kind: input.kind },
    output_files: [{ relative_path: relativePath, size_bytes: size, sha256: digest }],
    dependency_closure: {
      input_asset_ids: [...input.inputAssetIds],
      upstream_result_manifest_ids: [input.operation.result_manifest_id],
      parameter_digest: canonicalDigest({ table_id: input.tableId, evidence_kind: input.kind }),
      implementation_digest: input.implementationDigest,
    },
    commit: { state: "committed", commit_id: `commit_${identity}`, committed_at: committedAt },
  };
}

export function resourceLimitsFor(limits: RuntimeLimits): Readonly<ResourceLimits> {
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
