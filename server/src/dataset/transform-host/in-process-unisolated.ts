import vm from "node:vm";
import { types } from "node:util";
import { gunzipSync } from "node:zlib";

import {
  parseTransformExecutionReceipt,
  type OutputReceipt,
  type TransformExecutionReceipt,
} from "@biomed/contracts";

import {
  assertCoreAuthoritativeContext,
  assertCoreAuthorityClaim,
  type CoreAuthoritativeTransformContext,
  type CoreAuthorityClaim,
} from "./authority.js";
import { TransformBundleStore, type StoredTransformBundle } from "./bundle-store.js";
import { TransformHostError } from "./errors.js";
import { sha256Bytes } from "./hashing.js";

const SDK_MODULE = "@biomed/transform-sdk/v1";
const RUNTIME_POLICY = "in-process-unisolated.1";
const GZIP_MAGIC = Object.freeze([0x1f, 0x8b]);

export interface InProcessUnisolatedInputBytes {
  readonly handle: string;
  readonly receiptKind: "asset" | "result";
  readonly receiptId: string;
  readonly bytes: Uint8Array;
}

export interface InProcessUnisolatedRequest {
  readonly authorityClaim: CoreAuthorityClaim;
  readonly bundle: StoredTransformBundle;
  /** Exact Core-owned registered bytes in authority inputHandles order. */
  readonly inputs?: readonly Readonly<InProcessUnisolatedInputBytes>[];
  readonly signal?: AbortSignal;
  readonly isGenerationCurrent: (generation: number, cancelFence: string) => boolean;
}

export interface InProcessUnisolatedOutput {
  readonly handle: string;
  readonly bytes: Uint8Array;
}

export interface InProcessUnisolatedResult {
  readonly receipt: TransformExecutionReceipt;
  readonly outputs: readonly InProcessUnisolatedOutput[];
  readonly stdout: string;
  readonly stderr: string;
}

export interface InProcessUnisolatedHostOptions {
  /** Must be true at the call site. This backend is never enabled implicitly. */
  readonly explicitlyEnabled: true;
  readonly bundleStore: TransformBundleStore;
  readonly authorityContext: CoreAuthoritativeTransformContext;
  readonly hostImplementationDigest: string;
  readonly now?: () => Date;
}

interface WireOutput {
  handle: string;
  table_id: string;
  schema_ref: string;
  locator_ref: string;
  content: string;
  row_count: number;
}

interface WireResult {
  outputs: WireOutput[];
}

interface RuntimeInput {
  readonly handle: string;
  readonly receipt_kind: "asset" | "result";
  readonly receipt_id: string;
  readonly text: string;
}

/**
 * Explicit opt-in backend for trusted deployments that need dynamic execution
 * before OS isolation exists. It executes in the Application Host process and
 * therefore is NOT a sandbox, isolation mechanism, or security boundary.
 *
 * Only bytes retained by TransformBundleStore from Host compilation can run.
 * Dataset Core still owns output admission, validation, and publication.
 */
export class InProcessUnisolatedTransformHost {
  readonly #store: TransformBundleStore;
  readonly #context: CoreAuthoritativeTransformContext;
  readonly #hostImplementationDigest: string;
  readonly #now: () => Date;

  constructor(options: InProcessUnisolatedHostOptions) {
    if (options.explicitlyEnabled !== true) {
      throw invalid("The in-process unisolated backend requires explicit opt-in");
    }
    if (!/^[0-9a-f]{64}$/u.test(options.hostImplementationDigest)) {
      throw invalid("hostImplementationDigest must be a lowercase SHA-256");
    }
    assertCoreAuthoritativeContext(options.authorityContext);
    this.#store = options.bundleStore;
    this.#context = options.authorityContext;
    this.#hostImplementationDigest = options.hostImplementationDigest;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(request: InProcessUnisolatedRequest): Promise<InProcessUnisolatedResult> {
    assertCoreAuthorityClaim(this.#context, request.authorityClaim);
    this.#assertFence(request);
    if (
      request.bundle.status !== "admitted_in_process_unisolated"
      || request.bundle.executable !== true
      || request.bundle.generation !== this.#context.generation
      || request.bundle.sha256 !== this.#context.bundleDigest
      || request.bundle.implementationDigest !== this.#context.implementationDigest
    ) {
      throw conflict("Bundle is not the exact admitted in-process generation");
    }

    // Validate all input identities and bytes before any admitted module code runs.
    const preparedInputs = prepareRuntimeInputs(request.inputs, this.#context);
    const runtimeInputs = preparedInputs.inputs;
    const inputBytes = preparedInputs.sizeBytes;

    // readVerifiedBytes re-hashes the retained FD immediately before execution.
    const bundleBytes = await this.#store.readVerifiedBytes(request.authorityClaim, request.bundle);
    if (sha256Bytes(bundleBytes) !== this.#context.bundleDigest) {
      throw conflict("Bundle digest mismatch immediately before execution");
    }
    this.#assertFence(request);

    const started = this.#validNow();
    const startedMs = started.getTime();
    const deadlineMs = Date.parse(this.#context.deadline);
    const wallBudgetMs = Math.min(
      this.#context.resourceLimits.wall_ms,
      Math.max(0, deadlineMs - startedMs),
    );
    if (wallBudgetMs < 1) {
      return this.#terminalResult(
        "timeout",
        started,
        started,
        [],
        "",
        "deadline elapsed",
        request,
        0,
        inputBytes,
      );
    }

    const logs = new BoundedLog(this.#context.resourceLimits.log_bytes);
    let terminal: "succeeded" | "failed" | "timeout" | "quota_exceeded" = "succeeded";
    let wireResult: WireResult = { outputs: [] };
    let errorDetail = "";
    const startedHr = process.hrtime.bigint();
    try {
      const rawResult = executeBundle(
        new TextDecoder().decode(bundleBytes),
        Math.max(1, Math.floor(wallBudgetMs)),
        logs,
        runtimeInputs,
      );
      wireResult = parseWireResult(rawResult, this.#context.outputHandles);
    } catch (error) {
      if (isVmTimeout(error)) terminal = "timeout";
      else if (error instanceof TransformHostError && error.code === "resource_limit_exceeded") {
        terminal = "quota_exceeded";
      } else terminal = "failed";
      errorDetail = error instanceof Error ? error.message : "Transform execution failed";
    }
    const elapsedMs = Number((process.hrtime.bigint() - startedHr) / 1_000_000n);
    const finished = this.#validNowAfter(started);

    // A stale generation or cancellation discards all bytes and cannot produce
    // a successful receipt, even if the synchronous call returned normally.
    this.#assertFence(request);
    if (terminal !== "succeeded") {
      return this.#terminalResult(
        terminal,
        started,
        finished,
        [],
        logs.stdout,
        `${logs.stderr}${errorDetail}`,
        request,
        elapsedMs,
        inputBytes,
      );
    }

    const outputLimit = this.#context.resourceLimits.output_bytes;
    const outputs: InProcessUnisolatedOutput[] = [];
    const receipts: OutputReceipt[] = [];
    let outputBytes = 0;
    for (const output of wireResult.outputs) {
      const bytes = new TextEncoder().encode(output.content);
      outputBytes += bytes.byteLength;
      if (outputBytes > outputLimit) {
        return this.#terminalResult(
          "quota_exceeded",
          started,
          finished,
          [],
          logs.stdout,
          `${logs.stderr}Transform output exceeds output_bytes`,
          request,
          elapsedMs,
          inputBytes,
        );
      }
      const digest = sha256Bytes(bytes);
      outputs.push(Object.freeze({ handle: output.handle, bytes: Uint8Array.from(bytes) }));
      receipts.push({
        table_id: output.table_id,
        schema_ref: output.schema_ref,
        artifact_ref: `transform-host://${this.#context.invocationId}/output/${output.handle}`,
        locator_ref: output.locator_ref,
        sha256: digest,
        size_bytes: bytes.byteLength,
        row_count: output.row_count,
      });
    }

    return this.#result(
      "succeeded",
      started,
      finished,
      receipts,
      outputs,
      logs.stdout,
      logs.stderr,
      request,
      elapsedMs,
      inputBytes,
      outputBytes,
    );
  }

  #assertFence(request: InProcessUnisolatedRequest): void {
    if (request.signal?.aborted) throw cancelled("Transform invocation was cancelled");
    if (!request.isGenerationCurrent(this.#context.generation, this.#context.cancelFence)) {
      throw cancelled("Transform invocation generation or cancel fence is stale");
    }
  }

  #terminalResult(
    terminal: "failed" | "timeout" | "quota_exceeded",
    started: Date,
    finished: Date,
    outputs: readonly InProcessUnisolatedOutput[],
    stdout: string,
    stderr: string,
    request: InProcessUnisolatedRequest,
    wallMs = 0,
    inputBytes = 0,
  ): InProcessUnisolatedResult {
    return this.#result(
      terminal,
      started,
      finished,
      [],
      outputs,
      stdout,
      stderr,
      request,
      wallMs,
      inputBytes,
      0,
    );
  }

  #result(
    terminal: "succeeded" | "failed" | "timeout" | "quota_exceeded",
    started: Date,
    finished: Date,
    outputReceipts: readonly OutputReceipt[],
    outputs: readonly InProcessUnisolatedOutput[],
    stdout: string,
    stderr: string,
    request: InProcessUnisolatedRequest,
    wallMs: number,
    inputBytes: number,
    outputBytes: number,
  ): InProcessUnisolatedResult {
    this.#assertFence(request);
    const stdoutBytes = Buffer.byteLength(stdout, "utf8");
    const stderrBytes = Buffer.byteLength(stderr, "utf8");
    const timestamp = finished.toISOString();
    const receipt = parseTransformExecutionReceipt({
      schema_version: "1.0",
      task_id: this.#context.taskId,
      run_id: this.#context.runId,
      build_id: this.#context.buildId,
      invocation_id: this.#context.invocationId,
      attempt: this.#context.attempt,
      generation: this.#context.generation,
      request_digest: this.#context.requestDigest,
      parameters_digest: this.#context.parametersDigest,
      family_spec_digest: this.#context.familySpecDigest,
      projection_digest: this.#context.projectionDigest,
      transform_digest: this.#context.transformDescriptorDigest,
      bundle_digest: this.#context.bundleDigest,
      compiler_digest: this.#context.compilerDigest,
      runtime_digest: this.#context.runtimeDigest,
      policy_digest: this.#context.policyDigest,
      input_asset_receipts: this.#context.inputAssetReceipts.map((entry) => ({ ...entry })),
      input_result_receipts: this.#context.inputResultReceipts.map((entry) => ({ ...entry })),
      granted_capabilities: ["bounded_log", "bounded_output"],
      resource_limits: { ...this.#context.resourceLimits },
      sandbox_backend: "in_process_unisolated",
      sandbox_config_digest: sha256Bytes(JSON.stringify({
        backend: "in_process_unisolated",
        policyVersion: RUNTIME_POLICY,
        securityBoundary: false,
      })),
      exit_state: terminal,
      exit_code: terminal === "succeeded" ? 0 : 1,
      exit_signal: null,
      wall_ms: Math.min(wallMs, this.#context.resourceLimits.wall_ms),
      cpu_ms: 0,
      rss_bytes: 0,
      temp_bytes: inputBytes,
      output_bytes: outputBytes,
      log_bytes: stdoutBytes + stderrBytes,
      quarantined_output_receipts: outputReceipts.map((entry) => ({ ...entry })),
      stdout_ref: `transform-host://${this.#context.invocationId}/stdout/in-memory`,
      stderr_ref: `transform-host://${this.#context.invocationId}/stderr/in-memory`,
      audit_refs: [
        `transform-host://${this.#context.invocationId}/in-process-unisolated-not-security-boundary`,
      ],
      cancellation_state: "none",
      cancel_requested_at: null,
      deadline_at: this.#context.deadline,
      started_at: started.toISOString(),
      finished_at: timestamp,
      host_implementation_digest: this.#hostImplementationDigest,
      host_issued_at: timestamp,
    }, "$.in_process_unisolated_receipt");
    return Object.freeze({
      receipt,
      outputs: Object.freeze([...outputs]),
      stdout,
      stderr,
    });
  }

  #validNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) throw invalid("Host clock returned an invalid timestamp");
    return value;
  }

  #validNowAfter(started: Date): Date {
    const value = this.#validNow();
    return value.getTime() < started.getTime() ? started : value;
  }
}

class BoundedLog {
  readonly #limit: number;
  #used = 0;
  #stdout = "";
  #stderr = "";

  constructor(limit: number) {
    this.#limit = limit;
  }

  write(stream: "stdout" | "stderr", values: readonly unknown[]): void {
    const line = `${values.map(formatLogValue).join(" ")}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.#used + bytes > this.#limit) {
      throw new TransformHostError("resource_limit_exceeded", "Transform log exceeds log_bytes");
    }
    this.#used += bytes;
    if (stream === "stdout") this.#stdout += line;
    else this.#stderr += line;
  }

  get stdout(): string { return this.#stdout; }
  get stderr(): string { return this.#stderr; }
}

function prepareRuntimeInputs(
  provided: readonly Readonly<InProcessUnisolatedInputBytes>[] | undefined,
  context: CoreAuthoritativeTransformContext,
): { readonly inputs: readonly RuntimeInput[]; readonly sizeBytes: number } {
  const inputs = provided ?? Object.freeze([]);
  if (!Object.isFrozen(inputs) || types.isProxy(inputs) || Object.getPrototypeOf(inputs) !== Array.prototype) {
    throw invalid("Request inputs must be a frozen plain non-Proxy array");
  }
  if (inputs.length !== context.inputHandles.length) {
    throw invalid("Request inputs must exactly match the Core-owned input handle closure");
  }

  const assetReceipts = new Map(
    context.inputAssetReceipts.map((receipt) => [receipt.asset_id, receipt] as const),
  );
  const resultReceipts = new Map(
    context.inputResultReceipts.map((receipt) => [receipt.result_manifest_id, receipt] as const),
  );
  const runtimeInputs: RuntimeInput[] = [];
  let sizeBytes = 0;
  let decodedSizeBytes = 0;

  for (const [index, expectedHandle] of context.inputHandles.entries()) {
    const input = inputs[index];
    if (input === undefined || !isInputBytes(input)) {
      throw invalid(`Request input ${index} must be a plain registered-byte input`);
    }
    if (
      input.handle !== expectedHandle.handle
      || input.receiptKind !== expectedHandle.receiptKind
      || input.receiptId !== expectedHandle.receiptId
    ) {
      throw invalid("Request input order or Core-owned handle binding does not match authority");
    }

    const receipt = input.receiptKind === "asset"
      ? assetReceipts.get(input.receiptId)
      : resultReceipts.get(input.receiptId);
    if (receipt === undefined) {
      throw invalid("Request input is not owned by the Core-authoritative receipt closure");
    }

    // Snapshot mutable caller memory before size/digest checks so the transform
    // receives text derived from the exact bytes that were re-hashed here.
    const bytes = Uint8Array.from(input.bytes);
    if (bytes.byteLength !== receipt.size_bytes || sha256Bytes(bytes) !== receipt.sha256) {
      throw invalid("Request input bytes do not match the Core-authoritative receipt");
    }
    sizeBytes += bytes.byteLength;
    if (sizeBytes > context.resourceLimits.temp_bytes) {
      throw new TransformHostError(
        "resource_limit_exceeded",
        "Aggregate transform input bytes exceed temp_bytes",
      );
    }
    let decodedBytes: Uint8Array = bytes;
    try {
      if (bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) {
        decodedBytes = Uint8Array.from(gunzipSync(bytes, {
          maxOutputLength: context.resourceLimits.temp_bytes - decodedSizeBytes,
        }));
      }
    } catch (error) {
      throw new TransformHostError(
        "resource_limit_exceeded",
        "Registered gzip transform input could not be decoded within temp_bytes",
        { cause: error },
      );
    }
    decodedSizeBytes += decodedBytes.byteLength;
    if (decodedSizeBytes > context.resourceLimits.temp_bytes) {
      throw new TransformHostError(
        "resource_limit_exceeded",
        "Decoded transform input bytes exceed temp_bytes",
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes);
    } catch (error) {
      throw new TransformHostError(
        "runtime_invalid",
        "Registered transform input must contain UTF-8 text or gzip-compressed UTF-8 text",
        { cause: error },
      );
    }
    runtimeInputs.push(Object.freeze({
      handle: input.handle,
      receipt_kind: input.receiptKind,
      receipt_id: input.receiptId,
      text,
    }));
  }

  return Object.freeze({
    inputs: Object.freeze(runtimeInputs),
    sizeBytes,
  });
}

function isInputBytes(value: unknown): value is Readonly<InProcessUnisolatedInputBytes> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || !Object.isFrozen(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (keys.join(",") !== "bytes,handle,receiptId,receiptKind") return false;
  const record = value as Record<string, unknown>;
  return keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  }) && typeof record.handle === "string"
    && (record.receiptKind === "asset" || record.receiptKind === "result")
    && typeof record.receiptId === "string"
    && record.bytes instanceof Uint8Array
    && !types.isProxy(record.bytes)
    && Object.getPrototypeOf(record.bytes) === Uint8Array.prototype;
}

function executeBundle(
  bundle: string,
  timeoutMs: number,
  logs: BoundedLog,
  inputs: readonly RuntimeInput[],
): unknown {
  const sdk = Object.freeze({
    defineTransform: (definition: unknown) => definition,
  });
  const runtimeRequest = Object.freeze({ inputs });
  const context = vm.createContext({
    console: Object.freeze({
      log: (...values: unknown[]) => logs.write("stdout", values),
      error: (...values: unknown[]) => logs.write("stderr", values),
      warn: (...values: unknown[]) => logs.write("stderr", values),
    }),
    module: { exports: {} },
    exports: {},
    require: (specifier: string): unknown => {
      if (specifier !== SDK_MODULE) throw invalid(`Runtime module ${specifier} is not allowed`);
      return sdk;
    },
  });
  context.exports = (context.module as { exports: unknown }).exports;
  context.__transformRequest = runtimeRequest;
  const script = new vm.Script(
    `${bundle}\n;globalThis.__transformResult = module.exports.transform.run(globalThis.__transformRequest);`,
    { filename: "admitted-transform.cjs" },
  );
  script.runInContext(context, { timeout: timeoutMs });
  return context.__transformResult;
}

function parseWireResult(value: unknown, expectedHandles: readonly string[]): WireResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw invalid("Transform result must be JSON-serializable", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("Transform result must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.outputs)) {
    throw invalid("Transform result must contain only an outputs array");
  }
  if (record.outputs.length !== expectedHandles.length) {
    throw invalid("Transform output closure does not match declared output handles");
  }
  const outputs = record.outputs.map((entry, index): WireOutput => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw invalid(`Transform output ${index} must be an object`);
    }
    const output = entry as Record<string, unknown>;
    const keys = ["content", "handle", "locator_ref", "row_count", "schema_ref", "table_id"];
    if (Object.keys(output).sort().join(",") !== keys.join(",")) {
      throw invalid(
        `Transform output ${index} must be a wire envelope with exactly: content, handle, locator_ref, row_count, schema_ref, table_id; it is not a rows object`, 
      );
    }
    const handle = stringField(output.handle, `outputs[${index}].handle`);
    if (handle !== expectedHandles[index]) throw invalid("Transform output handle order does not match declaration");
    const rowCount = output.row_count;
    if (!Number.isSafeInteger(rowCount) || (rowCount as number) < 0) {
      throw invalid(`outputs[${index}].row_count must be a non-negative safe integer`);
    }
    return {
      handle,
      table_id: stringField(output.table_id, `outputs[${index}].table_id`),
      schema_ref: stringField(output.schema_ref, `outputs[${index}].schema_ref`),
      locator_ref: stringField(output.locator_ref, `outputs[${index}].locator_ref`),
      content: stringField(output.content, `outputs[${index}].content`),
      row_count: rowCount as number,
    };
  });
  return { outputs };
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(`${label} must be a string`);
  return value;
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isVmTimeout(error: unknown): boolean {
  return types.isNativeError(error)
    && (("code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT")
      || /Script execution timed out/u.test(error.message));
}

function invalid(message: string, cause?: unknown): TransformHostError {
  return new TransformHostError("runtime_invalid", message, cause === undefined ? undefined : { cause });
}

function conflict(message: string): TransformHostError {
  return new TransformHostError("bundle_conflict", message);
}

function cancelled(message: string): TransformHostError {
  return new TransformHostError("invocation_cancelled", message);
}
