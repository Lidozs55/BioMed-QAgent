import {
  parseTransformExecutionReceipt,
  type TransformExecutionReceipt,
} from "@biomed/contracts";

import {
  assertCoreAuthoritativeContext,
  assertCoreAuthorityClaim,
  type CoreAuthoritativeTransformContext,
  type CoreAuthorityClaim,
} from "./authority.js";
import { TransformHostError } from "./errors.js";
import { sha256Bytes } from "./hashing.js";
import {
  parseTransformInvocationV1,
  sandboxUnavailableTerminal,
  type OpaqueInputHandleV1,
  type TransformInvocationV1,
  type TransformTerminalV1,
} from "./protocol.js";
import { detectSandboxAvailability, type SandboxAvailability } from "./sandbox.js";

export interface DisabledHostRequest {
  invocation: unknown;
  authorityClaim: CoreAuthorityClaim;
}

export interface DisabledHostResult {
  terminal: TransformTerminalV1;
  receipt: TransformExecutionReceipt;
  sandbox: SandboxAvailability;
}

export interface NonProductionTransformHostOptions {
  hostImplementationDigest: string;
  authorityContext: CoreAuthoritativeTransformContext;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

/**
 * Non-production control-plane fixture. It validates a strict protocol against
 * an object-identity Core capability and then emits sandbox_unavailable. It has
 * no code-loading or execution path and is not wired to production server code.
 */
export class NonProductionTransformHost {
  readonly #hostImplementationDigest: string;
  readonly #context: CoreAuthoritativeTransformContext;
  readonly #now: () => Date;
  readonly #platform: NodeJS.Platform | undefined;

  constructor(options: NonProductionTransformHostOptions) {
    if (!/^[0-9a-f]{64}$/.test(options.hostImplementationDigest)) {
      throw new TransformHostError(
        "protocol_invalid",
        "hostImplementationDigest must be a lowercase SHA-256 supplied by the Host build",
      );
    }
    assertCoreAuthoritativeContext(options.authorityContext);
    this.#hostImplementationDigest = options.hostImplementationDigest;
    this.#context = options.authorityContext;
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform;
  }

  execute(request: DisabledHostRequest): DisabledHostResult {
    assertCoreAuthorityClaim(this.#context, request.authorityClaim);
    const invocation = parseTransformInvocationV1(request.invocation);
    assertInvocationMatchesContext(invocation, this.#context);
    const sandbox = detectSandboxAvailability(this.#platform);
    const issuedAt = this.#now();
    if (!Number.isFinite(issuedAt.getTime())) {
      throw new TransformHostError("protocol_invalid", "Host clock returned an invalid timestamp");
    }
    const terminal = sandboxUnavailableTerminal(
      this.#context.invocationId,
      this.#context.generation,
      sandbox.detail,
    );
    const timestamp = issuedAt.toISOString();
    if (Date.parse(timestamp) > Date.parse(this.#context.deadline)) {
      throw new TransformHostError(
        "protocol_invalid",
        "Core-authoritative invocation deadline elapsed before disabled Host admission",
      );
    }
    const receipt = parseTransformExecutionReceipt({
      schema_version: "1.0",
      task_id: this.#context.taskId,
      run_id: this.#context.runId,
      requirement_id: this.#context.requirementId,
      invocation_id: this.#context.invocationId,
      attempt: this.#context.attempt,
      generation: this.#context.generation,
      request_digest: this.#context.requestDigest,
      parameters_digest: this.#context.parametersDigest,
      family_spec_digest: this.#context.familySpecDigest,
      projection_digest: this.#context.projectionDigest,
      transform_digest: this.#context.implementationDigest,
      bundle_digest: this.#context.bundleDigest,
      compiler_digest: this.#context.compilerDigest,
      runtime_digest: this.#context.runtimeDigest,
      policy_digest: this.#context.policyDigest,
      input_asset_receipts: this.#context.inputAssetReceipts.map((entry) => ({ ...entry })),
      input_result_receipts: this.#context.inputResultReceipts.map((entry) => ({ ...entry })),
      granted_capabilities: [],
      resource_limits: { ...this.#context.resourceLimits },
      sandbox_backend: "unavailable",
      sandbox_config_digest: sha256Bytes(JSON.stringify({
        available: false,
        platform: sandbox.platform,
        policyVersion: "disabled-unavailable.1",
      })),
      exit_state: "sandbox_unavailable",
      exit_code: null,
      exit_signal: null,
      wall_ms: 0,
      cpu_ms: 0,
      rss_bytes: 0,
      temp_bytes: 0,
      output_bytes: 0,
      log_bytes: 0,
      quarantined_output_receipts: [],
      stdout_ref: `transform-host://${this.#context.invocationId}/stdout/none`,
      stderr_ref: `transform-host://${this.#context.invocationId}/stderr/none`,
      audit_refs: [`transform-host://${this.#context.invocationId}/sandbox-unavailable`],
      cancellation_state: "none",
      cancel_requested_at: null,
      deadline_at: this.#context.deadline,
      started_at: timestamp,
      finished_at: timestamp,
      host_implementation_digest: this.#hostImplementationDigest,
      host_issued_at: timestamp,
    }, "$.disabled_transform_host_receipt");
    return { sandbox, terminal, receipt };
  }
}

function assertInvocationMatchesContext(
  invocation: TransformInvocationV1,
  context: CoreAuthoritativeTransformContext,
): void {
  const mismatches: string[] = [];
  const compare = (label: string, received: string | number, expected: string | number): void => {
    if (received !== expected) mismatches.push(label);
  };
  compare("taskId", invocation.taskId, context.taskId);
  compare("runId", invocation.runId, context.runId);
  compare("requirementId", invocation.requirementId, context.requirementId);
  compare("invocationId", invocation.invocationId, context.invocationId);
  compare("attempt", invocation.attempt, context.attempt);
  compare("generation", invocation.generation, context.generation);
  compare("requestDigest", invocation.requestDigest, context.requestDigest);
  compare("parametersDigest", invocation.parametersDigest, context.parametersDigest);
  compare("familySpecDigest", invocation.familySpecDigest, context.familySpecDigest);
  compare("projectionDigest", invocation.projectionDigest, context.projectionDigest);
  compare("implementationDigest", invocation.implementationDigest, context.implementationDigest);
  compare("bundleDigest", invocation.bundleDigest, context.bundleDigest);
  compare("codeBundleRef", invocation.codeBundleRef, context.codeBundleRef);
  compare("compilerDigest", invocation.compilerDigest, context.compilerDigest);
  compare("runtimeDigest", invocation.runtimeDigest, context.runtimeDigest);
  compare("policyDigest", invocation.policyDigest, context.policyDigest);
  compare("resourceClassId", invocation.resourceClassId, context.resourceClassId);
  compare("deadline", invocation.deadline, context.deadline);
  compare("cancelFence", invocation.cancelFence, context.cancelFence);
  if (!sameInputHandles(invocation.inputHandles, context.inputHandles)) mismatches.push("inputHandles");
  if (!sameStrings(invocation.outputHandles, context.outputHandles)) mismatches.push("outputHandles");
  if (mismatches.length > 0) {
    throw new TransformHostError(
      "protocol_invalid",
      `Invocation does not match the Core-authoritative context: ${mismatches.join(", ")}`,
    );
  }
}

function sameInputHandles(
  received: readonly OpaqueInputHandleV1[],
  expected: readonly OpaqueInputHandleV1[],
): boolean {
  return received.length === expected.length && received.every((entry, index) => {
    const target = expected[index];
    return target !== undefined
      && entry.handle === target.handle
      && entry.receiptKind === target.receiptKind
      && entry.receiptId === target.receiptId;
  });
}

function sameStrings(received: readonly string[], expected: readonly string[]): boolean {
  return received.length === expected.length
    && received.every((entry, index) => entry === expected[index]);
}
