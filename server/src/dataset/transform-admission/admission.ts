import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  buildTransformDescriptorDigestCanonical,
  computeFamilySpecDigest,
  computeImplementationDigest,
  parseTransformExecutionReceipt,
  verifyFamilySpecDigest,
  type InputAssetReceipt,
  type InputResultReceipt,
  type OutputReceipt,
  type SourceLocatorV2,
  type TransformExecutionReceipt,
} from "@biomed/contracts";

import { canonicalDigest } from "../adapters/identity.js";
import { assertRelativePath } from "../contracts/primitives.js";
import type {
  CoreCommittedTransformOutput,
  ExpectedTransformCancelFence,
  ExpectedTransformInvocation,
  ExpectedTransformOutputDescriptor,
  TransformAdmissionRejectionCode,
  TransformAdmissionRequest,
  TransformQuarantineAdmissionEvidence,
  TransformReceiptEvidence,
} from "./types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUFFER_SIZE = 64 * 1024;
const RESOURCE_LIMIT_KEYS = [
  "wall_ms",
  "cpu_ms",
  "rss_bytes",
  "temp_bytes",
  "output_bytes",
  "log_bytes",
  "open_files",
  "pids",
] as const;

class AdmissionRejection extends Error {
  constructor(
    readonly code: TransformAdmissionRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

interface ReceiptEnvelope {
  evidenceClass: TransformQuarantineAdmissionEvidence["receipt_evidence_class"];
  fixtureId: string | null;
  wireValue: unknown;
}

interface RootIdentity {
  resolvedPath: string;
  realPath: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
}

interface FileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  nlink: number;
}

interface FileInspection {
  sha256: string;
  sizeBytes: number;
  header: string[];
  rowCount: number;
}

interface PreparedOutput {
  descriptor: ExpectedTransformOutputDescriptor;
  receipt: OutputReceipt;
  inspection: FileInspection;
}

function rejection(
  code: TransformAdmissionRejectionCode,
  detail: string,
): never {
  throw new AdmissionRejection(code, detail);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : "unknown transform admission error";
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    rejection("INVALID_EXPECTED_INVOCATION", `${name} must be a non-empty string`);
  }
}

function assertNoNul(value: string, name: string): void {
  if (value.includes("\0")) {
    rejection("INVALID_EXPECTED_INVOCATION", `${name} must not contain NUL`);
  }
}

function assertDigest(value: string, name: string): string {
  if (!SHA256_PATTERN.test(value)) {
    rejection("INVALID_EXPECTED_INVOCATION", `${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    rejection("INVALID_EXPECTED_INVOCATION", `${name} must be a non-negative safe integer`);
  }
}

function exactArray<T>(
  left: readonly T[],
  right: readonly T[],
  equal: (leftItem: T, rightItem: T) => boolean,
): boolean {
  return left.length === right.length && left.every((item, index) => equal(item, right[index]));
}

function sameInputAsset(left: InputAssetReceipt, right: InputAssetReceipt): boolean {
  return left.asset_id === right.asset_id
    && left.role === right.role
    && left.sha256 === right.sha256
    && left.size_bytes === right.size_bytes
    && left.locator_ref === right.locator_ref;
}

function sameInputResult(left: InputResultReceipt, right: InputResultReceipt): boolean {
  return left.result_manifest_id === right.result_manifest_id
    && left.role === right.role
    && left.sha256 === right.sha256
    && left.size_bytes === right.size_bytes
    && left.locator_ref === right.locator_ref;
}

function tupleKey(...parts: string[]): string {
  for (const [index, part] of parts.entries()) {
    if (part.includes("\0")) {
      rejection("INVALID_EXPECTED_INVOCATION", `tuple part ${index} must not contain NUL`);
    }
  }
  return JSON.stringify(parts);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function receiptEnvelope(evidence: TransformReceiptEvidence): ReceiptEnvelope {
  if (evidence.evidence_class === "production_host_receipt") {
    return {
      evidenceClass: "production_host_receipt",
      fixtureId: null,
      wireValue: evidence.wire_receipt,
    };
  }
  if (evidence.evidence_class === "synthetic_test_fixture_receipt") {
    assertNonEmptyString(evidence.fixture_id, "receipt_evidence.fixture_id");
    assertNoNul(evidence.fixture_id, "receipt_evidence.fixture_id");
    return {
      evidenceClass: "synthetic_test_fixture_receipt",
      fixtureId: evidence.fixture_id,
      wireValue: evidence.fixture_receipt,
    };
  }
  rejection("INVALID_RECEIPT", "receipt_evidence must use an explicit production or fixture evidence class");
}

function validateLocatorStrings(locator: SourceLocatorV2, name: string): void {
  assertNoNul(locator.asset_id, `${name}.asset_id`);
  assertNoNul(locator.logical_file, `${name}.logical_file`);
  assertNoNul(locator.raw_value, `${name}.raw_value`);
  switch (locator.locator_type) {
    case "json_pointer":
      assertNoNul(locator.json_pointer, `${name}.json_pointer`);
      break;
    case "xml_cell":
      assertNoNul(locator.xml_path, `${name}.xml_path`);
      assertNoNul(locator.table_id, `${name}.table_id`);
      break;
    case "pdf_region":
      if (locator.table_id !== null) assertNoNul(locator.table_id, `${name}.table_id`);
      if (locator.figure_id !== null) assertNoNul(locator.figure_id, `${name}.figure_id`);
      if (locator.row_label !== null) assertNoNul(locator.row_label, `${name}.row_label`);
      if (locator.column_label !== null) assertNoNul(locator.column_label, `${name}.column_label`);
      break;
    case "image_bbox":
      if (locator.figure_id !== null) assertNoNul(locator.figure_id, `${name}.figure_id`);
      break;
  }
}

function validateExpectedOutputs(
  expected: ExpectedTransformInvocation,
): ExpectedTransformOutputDescriptor[] {
  if (expected.expected_outputs.length === 0) {
    rejection("OUTPUT_CLOSURE_MISMATCH", "expected output closure must not be empty");
  }
  const tableKeys = new Set<string>();
  const paths = new Set<string>();
  const artifacts = new Set<string>();
  const knownAssets = new Set(expected.input_asset_receipts.map((input) => input.asset_id));

  return expected.expected_outputs.map((descriptor, index) => {
    const name = `expected_outputs[${index}]`;
    for (const [field, value] of [
      ["table_id", descriptor.table_id],
      ["schema_ref", descriptor.schema_ref],
      ["artifact_ref", descriptor.artifact_ref],
      ["locator_ref", descriptor.locator_ref],
      ["relative_path", descriptor.relative_path],
    ] as const) {
      assertNonEmptyString(value, `${name}.${field}`);
      assertNoNul(value, `${name}.${field}`);
    }
    let relativePath: string;
    try {
      relativePath = assertRelativePath(descriptor.relative_path, `${name}.relative_path`);
    } catch (error) {
      rejection("INVALID_EXPECTED_INVOCATION", errorDetail(error));
    }
    if (relativePath !== descriptor.relative_path || relativePath.includes("\\")) {
      rejection("INVALID_EXPECTED_INVOCATION", `${name}.relative_path must use canonical forward slashes`);
    }
    if (descriptor.delimiter !== "," && descriptor.delimiter !== "\t") {
      rejection("INVALID_EXPECTED_INVOCATION", `${name}.delimiter must be comma or tab`);
    }
    if (!Array.isArray(descriptor.header) || descriptor.header.length === 0) {
      rejection("INVALID_EXPECTED_INVOCATION", `${name}.header must not be empty`);
    }
    const header = descriptor.header.map((column, columnIndex) => {
      assertNonEmptyString(column, `${name}.header[${columnIndex}]`);
      assertNoNul(column, `${name}.header[${columnIndex}]`);
      return column;
    });
    if (new Set(header).size !== header.length) {
      rejection("INVALID_EXPECTED_INVOCATION", `${name}.header columns must be unique`);
    }
    if (!Array.isArray(descriptor.source_locators) || descriptor.source_locators.length === 0) {
      rejection("LOCATOR_CLOSURE_MISMATCH", `${name}.source_locators must not be empty`);
    }
    const sourceLocators = descriptor.source_locators.map((locator, locatorIndex) => {
      validateLocatorStrings(locator, `${name}.source_locators[${locatorIndex}]`);
      if (!knownAssets.has(locator.asset_id)) {
        rejection(
          "LOCATOR_CLOSURE_MISMATCH",
          `${name} locator references unknown input asset ${locator.asset_id}`,
        );
      }
      return locator;
    });

    const tableKey = tupleKey(descriptor.table_id, descriptor.schema_ref);
    if (tableKeys.has(tableKey)) {
      rejection("OUTPUT_CLOSURE_MISMATCH", "output table/schema tuples must be unique");
    }
    tableKeys.add(tableKey);
    if (paths.has(relativePath) || artifacts.has(descriptor.artifact_ref)) {
      rejection("OUTPUT_CLOSURE_MISMATCH", "output paths and artifact refs must be unique");
    }
    // Multiple tables derived from one registered source legitimately share its
    // locator_ref. Table identity remains closed by table/schema, artifact_ref,
    // relative_path, and the admitted receipt digest tuple.
    paths.add(relativePath);
    artifacts.add(descriptor.artifact_ref);
    return {
      ...descriptor,
      relative_path: relativePath,
      header,
      source_locators: sourceLocators,
    };
  });
}

async function validateExpectedInvocation(
  expected: ExpectedTransformInvocation,
): Promise<ExpectedTransformOutputDescriptor[]> {
  if (expected.owner !== "dataset_core") {
    rejection("INVALID_EXPECTED_INVOCATION", "ExpectedTransformInvocation must be Core-owned");
  }
  for (const [name, value] of [
    ["task_id", expected.task_id],
    ["run_id", expected.run_id],
    ["requirement_id", expected.requirement_id],
    ["invocation_id", expected.invocation_id],
    ["request_digest", expected.request_digest],
    ["parameters_digest", expected.parameters_digest],
    ["projection_digest", expected.projection_digest],
    ["transform_descriptor_digest", expected.transform_descriptor_digest],
    ["implementation_digest", expected.implementation_digest],
    ["compiler_digest", expected.compiler_digest],
    ["runtime_digest", expected.runtime_digest],
  ] as const) {
    assertNonEmptyString(value, `expected_invocation.${name}`);
    assertNoNul(value, `expected_invocation.${name}`);
  }
  assertSafeNonNegativeInteger(expected.attempt, "expected_invocation.attempt");
  assertSafeNonNegativeInteger(expected.generation, "expected_invocation.generation");

  const familyIsValid = await verifyFamilySpecDigest(expected.family_spec);
  const familyDigest = await computeFamilySpecDigest(expected.family_spec);
  if (!familyIsValid || familyDigest !== expected.family_spec.canonical_digest) {
    rejection("INVALID_FAMILY_SPEC_DIGEST", "FamilySpec canonical digest verification failed");
  }

  const implementationDigest = await computeImplementationDigest(expected.implementation);
  if (implementationDigest !== assertDigest(expected.implementation_digest, "implementation_digest")) {
    rejection("INVALID_EXPECTED_INVOCATION", "implementation digest does not close over its descriptor");
  }
  const descriptorDigest = sha256Text(
    buildTransformDescriptorDigestCanonical(expected.transform_descriptor),
  );
  if (descriptorDigest !== assertDigest(expected.transform_descriptor_digest, "transform_descriptor_digest")) {
    rejection("INVALID_EXPECTED_INVOCATION", "transform descriptor digest does not close over its descriptor");
  }
  if (
    expected.transform_descriptor.implementation_digest !== implementationDigest
    || expected.transform_descriptor.bound_family_spec_digest !== familyDigest
    || expected.transform_descriptor.bound_projection_digest !== expected.projection_digest
  ) {
    rejection(
      "INVALID_EXPECTED_INVOCATION",
      "transform descriptor implementation/family/projection bindings are inconsistent",
    );
  }

  const outputs = validateExpectedOutputs(expected);
  const descriptorOutputs = expected.transform_descriptor.declared_output_tables;
  const familyOutputs = expected.family_spec.declared_outputs;
  const sameOutput = (
    left: { table_id: string; schema_ref: string },
    right: { table_id: string; schema_ref: string },
  ): boolean => left.table_id === right.table_id && left.schema_ref === right.schema_ref;
  if (
    !exactArray(descriptorOutputs, outputs, sameOutput)
    || !exactArray(familyOutputs, outputs, sameOutput)
  ) {
    rejection(
      "OUTPUT_CLOSURE_MISMATCH",
      "FamilySpec, transform descriptor, and Core output descriptors must declare the same ordered closure",
    );
  }

  const declaredRoles = new Set(expected.transform_descriptor.declared_input_roles.map((entry) => entry.role));
  if (declaredRoles.size !== expected.transform_descriptor.declared_input_roles.length) {
    rejection("INVALID_EXPECTED_INVOCATION", "transform input roles must be unique");
  }
  for (const [kind, inputs] of [
    ["asset", expected.input_asset_receipts],
    ["result", expected.input_result_receipts],
  ] as const) {
    for (const [index, input] of inputs.entries()) {
      assertNoNul(input.role, `${kind} input ${index} role`);
      assertNoNul(input.locator_ref, `${kind} input ${index} locator_ref`);
      if (!declaredRoles.has(input.role)) {
        rejection("INPUT_CLOSURE_MISMATCH", `${kind} input role ${input.role} is not declared`);
      }
    }
  }
  for (const role of declaredRoles) {
    const present = expected.input_asset_receipts.some((input) => input.role === role)
      || expected.input_result_receipts.some((input) => input.role === role);
    if (!present) {
      rejection("INPUT_CLOSURE_MISMATCH", `declared input role ${role} has no exact input receipt`);
    }
  }

  assertDigest(expected.request_digest, "request_digest");
  assertDigest(expected.parameters_digest, "parameters_digest");
  assertDigest(expected.projection_digest, "projection_digest");
  assertDigest(expected.compiler_digest, "compiler_digest");
  assertDigest(expected.runtime_digest, "runtime_digest");
  assertDigest(expected.backend_policy.policy_digest, "backend_policy.policy_digest");
  assertDigest(expected.backend_policy.sandbox_config_digest, "backend_policy.sandbox_config_digest");
  if (new Set(expected.backend_policy.granted_capabilities).size !== expected.backend_policy.granted_capabilities.length) {
    rejection("INVALID_EXPECTED_INVOCATION", "granted capabilities must be unique");
  }
  for (const capability of expected.backend_policy.granted_capabilities) {
    assertNoNul(capability, "backend_policy.granted_capabilities");
  }
  for (const key of RESOURCE_LIMIT_KEYS) {
    assertSafeNonNegativeInteger(expected.backend_policy.resource_limits[key], `resource_limits.${key}`);
  }
  assertCancelFenceShape(expected.cancel_fence, "expected cancel fence");
  if (expected.cancel_fence.cancellation_state !== "none") {
    rejection("LATE_CANCELLATION", "an invocation with an existing cancellation cannot be admitted");
  }
  const deadline = Date.parse(expected.deadline_fence.deadline_at);
  const canonicalDeadline = Number.isFinite(deadline)
    ? new Date(deadline).toISOString()
    : null;
  if (
    canonicalDeadline === null
    || (
      expected.deadline_fence.deadline_at !== canonicalDeadline
      && expected.deadline_fence.deadline_at !== canonicalDeadline.replace(".000Z", "Z")
    )
  ) {
    rejection("INVALID_EXPECTED_INVOCATION", "deadline fence must be a canonical UTC timestamp");
  }
  return outputs;
}

function assertInvocationBinding(
  receipt: TransformExecutionReceipt,
  expected: ExpectedTransformInvocation,
): void {
  const scalarBindings: ReadonlyArray<readonly [string, string | number, string | number]> = [
    ["task_id", receipt.task_id, expected.task_id],
    ["run_id", receipt.run_id, expected.run_id],
    ["requirement_id", receipt.requirement_id, expected.requirement_id],
    ["invocation_id", receipt.invocation_id, expected.invocation_id],
    ["attempt", receipt.attempt, expected.attempt],
    ["generation", receipt.generation, expected.generation],
    ["request_digest", receipt.request_digest, expected.request_digest],
    ["parameters_digest", receipt.parameters_digest, expected.parameters_digest],
    ["family_spec_digest", receipt.family_spec_digest, expected.family_spec.canonical_digest],
    ["projection_digest", receipt.projection_digest, expected.projection_digest],
    ["transform_digest", receipt.transform_digest, expected.transform_descriptor_digest],
    ["bundle_digest", receipt.bundle_digest, expected.implementation.emitted_bundle_sha256],
    ["compiler_digest", receipt.compiler_digest, expected.compiler_digest],
    ["runtime_digest", receipt.runtime_digest, expected.runtime_digest],
    ["policy_digest", receipt.policy_digest, expected.backend_policy.policy_digest],
    ["sandbox_backend", receipt.sandbox_backend, expected.backend_policy.sandbox_backend],
    ["sandbox_config_digest", receipt.sandbox_config_digest, expected.backend_policy.sandbox_config_digest],
    ["host_implementation_digest", receipt.host_implementation_digest, expected.implementation_digest],
    ["deadline_at", receipt.deadline_at, expected.deadline_fence.deadline_at],
    ["cancellation_state", receipt.cancellation_state, expected.cancel_fence.cancellation_state],
    ["cancel_requested_at", receipt.cancel_requested_at ?? "<null>", expected.cancel_fence.cancel_requested_at ?? "<null>"],
  ];
  const mismatch = scalarBindings.find(([, actual, wanted]) => actual !== wanted);
  if (mismatch !== undefined) {
    rejection("INVOCATION_BINDING_MISMATCH", `${mismatch[0]} does not match the Core-owned invocation`);
  }
  if (
    !exactArray(receipt.input_asset_receipts, expected.input_asset_receipts, sameInputAsset)
    || !exactArray(receipt.input_result_receipts, expected.input_result_receipts, sameInputResult)
  ) {
    rejection("INPUT_CLOSURE_MISMATCH", "receipt inputs do not exactly match the Core-owned input closure");
  }
  if (
    !exactArray(
      receipt.granted_capabilities,
      expected.backend_policy.granted_capabilities,
      (left, right) => left === right,
    )
  ) {
    rejection("INVOCATION_BINDING_MISMATCH", "granted capabilities do not exactly match backend policy");
  }
  for (const key of RESOURCE_LIMIT_KEYS) {
    if (receipt.resource_limits[key] !== expected.backend_policy.resource_limits[key]) {
      rejection("INVOCATION_BINDING_MISMATCH", `resource limit ${key} does not match backend policy`);
    }
  }
}

function assertOutputReceiptClosure(
  outputs: readonly OutputReceipt[],
  expected: readonly ExpectedTransformOutputDescriptor[],
  admittedInputLocators: ReadonlySet<string>,
): void {
  if (outputs.length !== expected.length) {
    rejection("OUTPUT_CLOSURE_MISMATCH", "receipt output count does not match the Core closure");
  }
  const seen = new Set<string>();
  for (const [index, output] of outputs.entries()) {
    const descriptor = expected[index];
    const key = tupleKey(output.table_id, output.schema_ref);
    if (seen.has(key)) {
      rejection("OUTPUT_CLOSURE_MISMATCH", "receipt output table/schema tuples must be unique");
    }
    seen.add(key);
    if (
      output.table_id !== descriptor.table_id
      || output.schema_ref !== descriptor.schema_ref
      || output.artifact_ref !== descriptor.artifact_ref
      || (
        output.locator_ref !== descriptor.locator_ref
        && !admittedInputLocators.has(output.locator_ref)
      )
    ) {
      rejection("OUTPUT_CLOSURE_MISMATCH", `receipt output ${index} does not match its Core descriptor`);
    }
  }
}

function assertCancelFenceShape(fence: ExpectedTransformCancelFence, name: string): void {
  if ((fence.cancellation_state === "none") !== (fence.cancel_requested_at === null)) {
    rejection("LATE_CANCELLATION", `${name} has inconsistent cancellation time closure`);
  }
  if (fence.cancel_requested_at !== null && !Number.isFinite(Date.parse(fence.cancel_requested_at))) {
    rejection("LATE_CANCELLATION", `${name} cancel_requested_at is invalid`);
  }
}

function sameCancelFence(
  left: ExpectedTransformCancelFence,
  right: ExpectedTransformCancelFence,
): boolean {
  return left.cancellation_state === right.cancellation_state
    && left.cancel_requested_at === right.cancel_requested_at;
}

async function assertCurrentCancelFence(request: TransformAdmissionRequest, phase: string): Promise<void> {
  let current: ExpectedTransformCancelFence;
  try {
    current = await request.read_current_cancel_fence();
  } catch (error) {
    rejection("LATE_CANCELLATION", `${phase}: cancel fence could not be read: ${errorDetail(error)}`);
  }
  assertCancelFenceShape(current, `${phase} cancel fence`);
  if (
    !sameCancelFence(current, request.expected_invocation.cancel_fence)
    || current.cancellation_state !== "none"
  ) {
    rejection("LATE_CANCELLATION", `${phase}: cancellation fence advanced during admission`);
  }
}

function identityFromStats(resolvedPath: string, realPath: string, stats: Stats): RootIdentity {
  return {
    resolvedPath,
    realPath,
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

function sameRootIdentity(identity: RootIdentity, stats: Stats): boolean {
  return stats.isDirectory()
    && !stats.isSymbolicLink()
    && stats.dev === identity.dev
    && stats.ino === identity.ino
    && stats.birthtimeMs === identity.birthtimeMs;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function captureRealDirectory(input: string, name: string): Promise<RootIdentity> {
  const resolvedPath = path.resolve(input);
  const stats = await lstat(resolvedPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    rejection("INVALID_QUARANTINE_PATH", `${name} must be a real directory`);
  }
  const realPath = await realpath(resolvedPath);
  if (!sameFilesystemPath(realPath, resolvedPath)) {
    rejection("INVALID_QUARANTINE_PATH", `${name} must not traverse a symlink or junction`);
  }
  return identityFromStats(resolvedPath, realPath, stats);
}

async function assertRootUnchanged(identity: RootIdentity, name: string): Promise<void> {
  const stats = await lstat(identity.resolvedPath);
  const currentRealPath = await realpath(identity.resolvedPath);
  if (!sameRootIdentity(identity, stats) || !sameFilesystemPath(currentRealPath, identity.realPath)) {
    rejection("INVALID_QUARANTINE_PATH", `${name} was swapped during admission`);
  }
}

function sameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function expectedDirectories(relativePaths: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const relativePath of relativePaths) {
    const segments = relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

async function assertClosedWorldRoot(
  root: RootIdentity,
  relativePaths: readonly string[],
  name: string,
): Promise<void> {
  await assertRootUnchanged(root, name);
  const expectedFiles = new Set(relativePaths);
  const expectedDirs = expectedDirectories(relativePaths);
  const actualFiles = new Set<string>();
  const actualDirs = new Set<string>();

  async function visit(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativeEntry = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const absoluteEntry = path.join(absoluteDirectory, entry.name);
      const stats = await lstat(absoluteEntry);
      if (stats.isSymbolicLink()) {
        rejection("INVALID_QUARANTINE_PATH", `${name}/${relativeEntry} is a symlink or junction`);
      }
      if (stats.isDirectory()) {
        if (!expectedDirs.has(relativeEntry)) {
          rejection("OUTPUT_CLOSURE_MISMATCH", `${name} contains undeclared directory ${relativeEntry}`);
        }
        actualDirs.add(relativeEntry);
        await visit(absoluteEntry, relativeEntry);
      } else if (stats.isFile()) {
        if (stats.nlink !== 1) {
          rejection("INVALID_QUARANTINE_PATH", `${name}/${relativeEntry} is hard-linked`);
        }
        if (!expectedFiles.has(relativeEntry)) {
          rejection("OUTPUT_CLOSURE_MISMATCH", `${name} contains undeclared file ${relativeEntry}`);
        }
        actualFiles.add(relativeEntry);
      } else {
        rejection("INVALID_QUARANTINE_PATH", `${name}/${relativeEntry} is not a regular file`);
      }
    }
  }

  await visit(root.realPath, "");
  if (actualFiles.size !== expectedFiles.size || actualDirs.size !== expectedDirs.size) {
    rejection("OUTPUT_CLOSURE_MISMATCH", `${name} does not contain the exact expected file closure`);
  }
  await assertRootUnchanged(root, name);
}

function fileSnapshot(stats: Stats): FileSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
    nlink: stats.nlink,
  };
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
    && left.nlink === right.nlink;
}

class DelimitedShapeScanner {
  private state: "field_start" | "unquoted" | "quoted" | "after_quote" = "field_start";
  private expectLineFeed = false;
  private field = "";
  private fields: string[] = [];
  private headerValue: string[] | null = null;
  private dataRows = 0;
  private sawInput = false;

  constructor(private readonly delimiter: "," | "\t") {}

  feed(text: string): void {
    if (text.includes("\0")) {
      rejection("OUTPUT_BYTES_MISMATCH", "output table bytes contain NUL");
    }
    for (const character of text) {
      this.sawInput = true;
      if (this.expectLineFeed) {
        if (character !== "\n") {
          rejection("OUTPUT_BYTES_MISMATCH", "output table contains a bare carriage return");
        }
        this.expectLineFeed = false;
        continue;
      }
      if (this.state === "quoted") {
        if (character === "\"") {
          this.state = "after_quote";
        } else {
          this.field += character;
        }
        continue;
      }
      if (this.state === "after_quote") {
        if (character === "\"") {
          this.field += "\"";
          this.state = "quoted";
        } else if (character === this.delimiter) {
          this.endField();
        } else if (character === "\n" || character === "\r") {
          this.endField();
          this.endRow();
          if (character === "\r") this.expectLineFeed = true;
        } else {
          rejection("OUTPUT_BYTES_MISMATCH", "output table has bytes after a closing quote");
        }
        continue;
      }
      if (character === this.delimiter) {
        this.endField();
      } else if (character === "\n" || character === "\r") {
        this.endField();
        this.endRow();
        if (character === "\r") this.expectLineFeed = true;
      } else if (character === "\"") {
        if (this.state !== "field_start") {
          rejection("OUTPUT_BYTES_MISMATCH", "output table has a quote in an unquoted field");
        }
        this.state = "quoted";
      } else {
        this.field += character;
        this.state = "unquoted";
      }
    }
  }

  finish(): FileInspection["header"] extends never ? never : { header: string[]; rowCount: number } {
    if (this.expectLineFeed) {
      rejection("OUTPUT_BYTES_MISMATCH", "output table ends with a bare carriage return");
    }
    if (this.state === "quoted") {
      rejection("OUTPUT_BYTES_MISMATCH", "output table has an unterminated quoted field");
    }
    if (this.state !== "field_start" || this.fields.length > 0) {
      this.endField();
      this.endRow();
    }
    if (!this.sawInput || this.headerValue === null) {
      rejection("OUTPUT_HEADER_MISMATCH", "output table is empty");
    }
    return { header: this.headerValue, rowCount: this.dataRows };
  }

  private endField(): void {
    this.fields.push(this.field);
    this.field = "";
    this.state = "field_start";
  }

  private endRow(): void {
    if (this.headerValue === null) {
      this.headerValue = [...this.fields];
    } else {
      if (this.fields.length !== this.headerValue.length) {
        rejection("OUTPUT_BYTES_MISMATCH", "output table row width does not match its header");
      }
      this.dataRows += 1;
    }
    this.fields = [];
  }
}

async function inspectHandle(
  source: FileHandle,
  delimiter: "," | "\t",
  destination: FileHandle | null,
): Promise<FileInspection> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const scanner = new DelimitedShapeScanner(delimiter);
  const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (destination !== null) {
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(chunk, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) {
          rejection("ATOMIC_COMMIT_FAILED", "atomic output copy stopped before all bytes were written");
        }
        written += result.bytesWritten;
      }
    }
    try {
      scanner.feed(decoder.decode(chunk, { stream: true }));
    } catch (error) {
      if (error instanceof AdmissionRejection) throw error;
      rejection("OUTPUT_BYTES_MISMATCH", `output is not valid UTF-8: ${errorDetail(error)}`);
    }
    position += bytesRead;
    if (!Number.isSafeInteger(position)) {
      rejection("OUTPUT_BYTES_MISMATCH", "output file size exceeds safe integer range");
    }
  }
  try {
    scanner.feed(decoder.decode());
  } catch (error) {
    if (error instanceof AdmissionRejection) throw error;
    rejection("OUTPUT_BYTES_MISMATCH", `output is not valid UTF-8: ${errorDetail(error)}`);
  }
  const shape = scanner.finish();
  return {
    sha256: hash.digest("hex"),
    sizeBytes: position,
    header: shape.header,
    rowCount: shape.rowCount,
  };
}

async function openVerifiedFile(
  root: RootIdentity,
  relativePath: string,
  name: string,
): Promise<{ handle: FileHandle; snapshot: FileSnapshot }> {
  await assertRootUnchanged(root, name);
  const requestedPath = path.resolve(root.realPath, ...relativePath.split("/"));
  if (!sameOrInside(root.realPath, requestedPath) || requestedPath === root.realPath) {
    rejection("INVALID_QUARANTINE_PATH", `${relativePath} escapes ${name}`);
  }
  const before = await lstat(requestedPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    rejection("INVALID_QUARANTINE_PATH", `${name}/${relativePath} is not an independent regular file`);
  }
  if (!sameFilesystemPath(await realpath(requestedPath), requestedPath)) {
    rejection("INVALID_QUARANTINE_PATH", `${name}/${relativePath} traverses a symlink or junction`);
  }
  const handle = await open(requestedPath, "r");
  try {
    const opened = await handle.stat();
    const beforeSnapshot = fileSnapshot(before);
    const openedSnapshot = fileSnapshot(opened);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileSnapshot(beforeSnapshot, openedSnapshot)) {
      rejection("INVALID_QUARANTINE_PATH", `${name}/${relativePath} changed while being opened`);
    }
    return { handle, snapshot: openedSnapshot };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertHandleUnchanged(
  handle: FileHandle,
  snapshot: FileSnapshot,
  name: string,
): Promise<void> {
  const current = fileSnapshot(await handle.stat());
  if (!sameFileSnapshot(snapshot, current) || current.nlink !== 1) {
    rejection("INVALID_QUARANTINE_PATH", `${name} was mutated in place during admission`);
  }
}

function sameInspection(left: FileInspection, right: FileInspection): boolean {
  return left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && left.rowCount === right.rowCount
    && exactArray(left.header, right.header, (leftColumn, rightColumn) => leftColumn === rightColumn);
}

function assertInspection(
  inspection: FileInspection,
  receipt: OutputReceipt,
  descriptor: ExpectedTransformOutputDescriptor,
): void {
  if (inspection.sha256 !== receipt.sha256 || inspection.sizeBytes !== receipt.size_bytes) {
    rejection("OUTPUT_BYTES_MISMATCH", `output bytes do not match receipt for ${descriptor.relative_path}`);
  }
  if (!exactArray(inspection.header, descriptor.header, (left, right) => left === right)) {
    rejection("OUTPUT_HEADER_MISMATCH", `output header does not match schema descriptor ${descriptor.schema_ref}`);
  }
  if (inspection.rowCount !== receipt.row_count) {
    rejection("OUTPUT_ROW_COUNT_MISMATCH", `output row_count does not match ${descriptor.relative_path}`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EINVAL" && code !== "EBADF")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function createDestinationDirectories(stagingRoot: string, relativePaths: readonly string[]): Promise<void> {
  const directories = [...expectedDirectories(relativePaths)].sort(
    (left, right) => left.split("/").length - right.split("/").length,
  );
  for (const directory of directories) {
    await mkdir(path.join(stagingRoot, ...directory.split("/")));
  }
}

async function syncCommitDirectories(stagingRoot: string, relativePaths: readonly string[]): Promise<void> {
  const directories = [...expectedDirectories(relativePaths)].sort(
    (left, right) => right.split("/").length - left.split("/").length,
  );
  for (const directory of directories) {
    await syncDirectory(path.join(stagingRoot, ...directory.split("/")));
  }
  await syncDirectory(stagingRoot);
}

async function copyAndVerifyOutput(
  quarantine: RootIdentity,
  stagingRoot: string,
  receipt: OutputReceipt,
  descriptor: ExpectedTransformOutputDescriptor,
): Promise<PreparedOutput> {
  const source = await openVerifiedFile(quarantine, descriptor.relative_path, "quarantine root");
  if (source.snapshot.size !== receipt.size_bytes) {
    await source.handle.close();
    rejection(
      "OUTPUT_BYTES_MISMATCH",
      `${descriptor.relative_path} size differs from its receipt before copy`,
    );
  }
  const destinationPath = path.join(stagingRoot, ...descriptor.relative_path.split("/"));
  const destination = await open(destinationPath, "wx", 0o600);
  try {
    const copied = await inspectHandle(source.handle, descriptor.delimiter, destination);
    await destination.sync();
    await assertHandleUnchanged(source.handle, source.snapshot, `quarantine/${descriptor.relative_path}`);
    assertInspection(copied, receipt, descriptor);

    const sourceRehash = await inspectHandle(source.handle, descriptor.delimiter, null);
    await assertHandleUnchanged(source.handle, source.snapshot, `quarantine/${descriptor.relative_path}`);
    if (!sameInspection(copied, sourceRehash)) {
      rejection("INVALID_QUARANTINE_PATH", `${descriptor.relative_path} changed between FD re-hashes`);
    }
    return { descriptor, receipt, inspection: copied };
  } finally {
    await destination.close();
    await source.handle.close();
  }
}

async function inspectCommittedOutput(
  root: RootIdentity,
  prepared: PreparedOutput,
  name: string,
): Promise<void> {
  const opened = await openVerifiedFile(root, prepared.descriptor.relative_path, name);
  try {
    const inspection = await inspectHandle(opened.handle, prepared.descriptor.delimiter, null);
    await assertHandleUnchanged(opened.handle, opened.snapshot, `${name}/${prepared.descriptor.relative_path}`);
    if (!sameInspection(inspection, prepared.inspection)) {
      rejection("ATOMIC_COMMIT_FAILED", `${name}/${prepared.descriptor.relative_path} changed after copy`);
    }
  } finally {
    await opened.handle.close();
  }
}

function committedOutput(prepared: PreparedOutput): CoreCommittedTransformOutput {
  return {
    table_id: prepared.receipt.table_id,
    schema_ref: prepared.receipt.schema_ref,
    artifact_ref: prepared.receipt.artifact_ref,
    locator_ref: prepared.receipt.locator_ref,
    relative_path: prepared.descriptor.relative_path,
    delimiter: prepared.descriptor.delimiter,
    header: [...prepared.inspection.header],
    size_bytes: prepared.inspection.sizeBytes,
    sha256: prepared.inspection.sha256,
    row_count: prepared.inspection.rowCount,
    source_locators: [...prepared.descriptor.source_locators],
  };
}

function makeEvidence(
  envelope: ReceiptEnvelope,
  receipt: TransformExecutionReceipt | null,
  hostReceiptDigest: string | null,
  now: Date,
  admitted: {
    committedRootRef: string;
    outputDigest: string;
    outputs: CoreCommittedTransformOutput[];
  } | null,
  rejected: { code: TransformAdmissionRejectionCode; detail: string } | null,
): TransformQuarantineAdmissionEvidence {
  const identity = receipt === null
    ? {
        task_id: null,
        run_id: null,
        requirement_id: null,
        invocation_id: null,
        attempt: null,
        generation: null,
      }
    : {
        task_id: receipt.task_id,
        run_id: receipt.run_id,
        requirement_id: receipt.requirement_id,
        invocation_id: receipt.invocation_id,
        attempt: receipt.attempt,
        generation: receipt.generation,
      };
  const decision = admitted === null ? "rejected" : "admitted";
  const evidenceId = `transform_quarantine_admission_${canonicalDigest({
    decision,
    receipt_evidence_class: envelope.evidenceClass,
    fixture_id: envelope.fixtureId,
    host_receipt_digest: hostReceiptDigest,
    ...identity,
    rejection_code: rejected?.code ?? null,
    output_digest: admitted?.outputDigest ?? null,
  }).slice(0, 32)}`;
  return {
    schema_version: "1.0",
    evidence_kind: "transform_quarantine_admission",
    evidence_id: evidenceId,
    owner: "dataset_core",
    decision,
    receipt_evidence_class: envelope.evidenceClass,
    fixture_id: envelope.fixtureId,
    host_receipt_digest: hostReceiptDigest,
    ...identity,
    rejection_code: rejected?.code ?? null,
    rejection_detail: rejected?.detail ?? null,
    committed_root_ref: admitted?.committedRootRef ?? null,
    output_digest: admitted?.outputDigest ?? null,
    outputs: admitted?.outputs ?? [],
    issued_at: now.toISOString(),
  };
}

async function cleanupRoot(root: string | null): Promise<void> {
  if (root !== null) {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Core-side transform quarantine admission. The Host wire receipt is parsed
 * exactly once by parseTransformExecutionReceipt; every remaining authority is
 * supplied by ExpectedTransformInvocation and independently verified here.
 */
export async function admitTransformExecution(
  request: TransformAdmissionRequest,
): Promise<TransformQuarantineAdmissionEvidence> {
  const now = (request.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Core admission clock returned an invalid timestamp");
  }
  let envelope: ReceiptEnvelope;
  try {
    envelope = receiptEnvelope(request.receipt_evidence);
  } catch (error) {
    const fallback: ReceiptEnvelope = {
      evidenceClass: request.receipt_evidence.evidence_class === "synthetic_test_fixture_receipt"
        ? "synthetic_test_fixture_receipt"
        : "production_host_receipt",
      fixtureId: null,
      wireValue: null,
    };
    return makeEvidence(
      fallback,
      null,
      null,
      now,
      null,
      { code: "INVALID_RECEIPT", detail: errorDetail(error) },
    );
  }

  let receipt: TransformExecutionReceipt;
  try {
    receipt = parseTransformExecutionReceipt(envelope.wireValue, "$transform_execution_receipt");
  } catch (error) {
    return makeEvidence(
      envelope,
      null,
      null,
      now,
      null,
      { code: "INVALID_RECEIPT", detail: errorDetail(error) },
    );
  }
  const hostReceiptDigest = canonicalDigest(receipt);
  if (receipt.exit_state !== "succeeded") {
    return makeEvidence(
      envelope,
      receipt,
      hostReceiptDigest,
      now,
      null,
      {
        code: "NON_SUCCESS_TERMINAL_STATE",
        detail: `production admission rejects exit_state=${receipt.exit_state}`,
      },
    );
  }
  if (receipt.cancellation_state !== "none" || receipt.cancel_requested_at !== null) {
    return makeEvidence(
      envelope,
      receipt,
      hostReceiptDigest,
      now,
      null,
      { code: "LATE_CANCELLATION", detail: "successful receipt carries a cancellation fence" },
    );
  }

  let stagingRoot: string | null = null;
  let committedRootPath: string | null = null;
  try {
    const outputs = await validateExpectedInvocation(request.expected_invocation);
    if (now.getTime() > Date.parse(request.expected_invocation.deadline_fence.deadline_at)) {
      rejection("DEADLINE_FENCE_VIOLATION", "Core admission started after the invocation deadline");
    }
    assertInvocationBinding(receipt, request.expected_invocation);
    assertOutputReceiptClosure(
      receipt.quarantined_output_receipts,
      outputs,
      new Set([
        ...request.expected_invocation.input_asset_receipts.map((input) => input.locator_ref),
        ...request.expected_invocation.input_result_receipts.map((input) => input.locator_ref),
      ]),
    );
    await assertCurrentCancelFence(request, "before quarantine verification");

    const quarantine = await captureRealDirectory(request.quarantine_root, "quarantine root");
    const commitParent = await captureRealDirectory(request.core_commit_parent, "Core commit parent");
    if (
      sameOrInside(quarantine.realPath, commitParent.realPath)
      || sameOrInside(commitParent.realPath, quarantine.realPath)
    ) {
      rejection("ATOMIC_COMMIT_FAILED", "Core commit parent and quarantine root must be independent");
    }
    const relativePaths = outputs.map((output) => output.relative_path);
    await assertClosedWorldRoot(quarantine, relativePaths, "quarantine root");

    stagingRoot = path.join(commitParent.realPath, `.transform-quarantine-${randomUUID()}.partial`);
    await mkdir(stagingRoot, { mode: 0o700 });
    await createDestinationDirectories(stagingRoot, relativePaths);
    const stagingIdentity = await captureRealDirectory(stagingRoot, "staging root");
    const prepared: PreparedOutput[] = [];
    for (const [index, outputReceipt] of receipt.quarantined_output_receipts.entries()) {
      prepared.push(await copyAndVerifyOutput(quarantine, stagingRoot, outputReceipt, outputs[index]));
    }

    const totalOutputBytes = prepared.reduce((total, output) => total + output.inspection.sizeBytes, 0);
    const receiptedOutputBytes = receipt.quarantined_output_receipts.reduce(
      (total, output) => total + output.size_bytes,
      0,
    );
    if (
      !Number.isSafeInteger(totalOutputBytes)
      || totalOutputBytes !== receipt.output_bytes
      || receiptedOutputBytes !== receipt.output_bytes
    ) {
      rejection(
        "OUTPUT_BYTES_MISMATCH",
        "FD-verified bytes, output receipt total, and execution receipt output_bytes must be equal",
      );
    }

    await assertClosedWorldRoot(quarantine, relativePaths, "quarantine root");
    await assertClosedWorldRoot(stagingIdentity, relativePaths, "staging root");
    for (const output of prepared) {
      await inspectCommittedOutput(stagingIdentity, output, "staging root");
    }
    await syncCommitDirectories(stagingRoot, relativePaths);
    await assertRootUnchanged(quarantine, "quarantine root");
    await assertRootUnchanged(commitParent, "Core commit parent");
    await assertCurrentCancelFence(request, "before atomic rename");

    const stagedOutputs = prepared.map(committedOutput);
    const outputDigest = canonicalDigest(stagedOutputs);
    const rootName = `transform-quarantine-${outputDigest.slice(0, 24)}-${randomUUID()}`;
    committedRootPath = path.join(commitParent.realPath, rootName);
    await rename(stagingRoot, committedRootPath);
    stagingRoot = null;
    await syncDirectory(commitParent.realPath);

    const committedIdentity = await captureRealDirectory(committedRootPath, "committed root");
    await assertClosedWorldRoot(committedIdentity, relativePaths, "committed root");
    for (const output of prepared) {
      await inspectCommittedOutput(committedIdentity, output, "committed root");
    }
    await assertRootUnchanged(quarantine, "quarantine root");
    await assertRootUnchanged(commitParent, "Core commit parent");
    await assertCurrentCancelFence(request, "after committed re-hash");

    const evidence = makeEvidence(
      envelope,
      receipt,
      hostReceiptDigest,
      now,
      { committedRootRef: rootName, outputDigest, outputs: stagedOutputs },
      null,
    );
    committedRootPath = null;
    return evidence;
  } catch (error) {
    const code = error instanceof AdmissionRejection
      ? error.code
      : "ATOMIC_COMMIT_FAILED";
    const detail = errorDetail(error);
    try {
      await cleanupRoot(stagingRoot);
      await cleanupRoot(committedRootPath);
    } catch (cleanupError) {
      return makeEvidence(
        envelope,
        receipt,
        hostReceiptDigest,
        now,
        null,
        {
          code: "ATOMIC_COMMIT_FAILED",
          detail: `${detail}; partial-root cleanup failed: ${errorDetail(cleanupError)}`,
        },
      );
    }
    return makeEvidence(
      envelope,
      receipt,
      hostReceiptDigest,
      now,
      null,
      { code, detail },
    );
  }
}
