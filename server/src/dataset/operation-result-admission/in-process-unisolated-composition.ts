import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { OperationResultManifest } from "@biomed/contracts";

import type { InProcessUnisolatedResult } from "../transform-host/in-process-unisolated.js";
import { admitTransformExecution } from "../transform-admission/admission.js";
import type {
  ExpectedTransformCancelFence,
  ExpectedTransformInvocation,
} from "../transform-admission/types.js";
import { admitOperationResultFromQuarantine } from "./admission.js";
import type { ExpectedOperationAdmission } from "./types.js";

export interface AdmitInProcessUnisolatedResultInput {
  result: InProcessUnisolatedResult;
  expected_invocation: ExpectedTransformInvocation;
  expected_operation: ExpectedOperationAdmission;
  /** Existing private parent controlled by Dataset Core. */
  core_commit_parent: string;
  read_current_cancel_fence: () =>
    | ExpectedTransformCancelFence
    | Promise<ExpectedTransformCancelFence>;
  /** Resolve only opaque committed-root refs produced by transform admission. */
  resolve_committed_root: (committed_root_ref: string) => string | Promise<string>;
  now?: () => Date;
}

/**
 * Core-only composition for an already completed in-process unisolated result.
 * It does not execute a bundle and does not construct publication authority.
 */
export async function admitInProcessUnisolatedResult(
  input: AdmitInProcessUnisolatedResultInput,
): Promise<OperationResultManifest> {
  assertCompletedOutputClosure(input.result, input.expected_invocation);

  const quarantineRoot = await mkdtemp(path.join(tmpdir(), "biomed-core-unisolated-"));
  try {
    await writePrivateQuarantine(
      quarantineRoot,
      input.result,
      input.expected_invocation,
    );

    const evidence = await admitTransformExecution({
      receipt_evidence: {
        evidence_class: "production_host_receipt",
        wire_receipt: input.result.receipt,
      },
      expected_invocation: input.expected_invocation,
      quarantine_root: quarantineRoot,
      core_commit_parent: input.core_commit_parent,
      read_current_cancel_fence: input.read_current_cancel_fence,
      now: input.now,
    });
    if (evidence.decision !== "admitted") {
      throw new TypeError(
        `In-process quarantine admission rejected: ${evidence.rejection_code ?? "unknown"}: ${evidence.rejection_detail ?? "no detail"}`,
      );
    }

    return await admitOperationResultFromQuarantine({
      evidence,
      expected: input.expected_operation,
      resolve_committed_root: input.resolve_committed_root,
      now: input.now,
    });
  } finally {
    await rm(quarantineRoot, { recursive: true, force: true });
  }
}

function boundedRuntimeDiagnostic(stderr: string): string {
  let sanitized = "";
  for (const character of stderr) {
    const code = character.charCodeAt(0);
    if (code === 0) sanitized += "\\0";
    else if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) sanitized += "?";
    else sanitized += character;
    if (sanitized.length >= 2_048) break;
  }
  return sanitized.trim().slice(0, 2_048);
}

function assertCompletedOutputClosure(
  result: InProcessUnisolatedResult,
  expected: ExpectedTransformInvocation,
): void {
  if (result.receipt.exit_state !== "succeeded") {
    const diagnostic = boundedRuntimeDiagnostic(result.stderr);
    throw new TypeError(
      `Cannot compose non-succeeded in-process result: ${result.receipt.exit_state}`
      + (diagnostic.length === 0 ? "" : `: ${diagnostic}`),
    );
  }
  const receipts = result.receipt.quarantined_output_receipts;
  if (
    result.outputs.length !== receipts.length
    || result.outputs.length !== expected.expected_outputs.length
  ) {
    throw new TypeError(
      "In-process output, receipt, and Core descriptor counts must match exactly",
    );
  }

  const seenHandles = new Set<string>();
  for (const [index, output] of result.outputs.entries()) {
    if (output.handle.length === 0 || output.handle.includes("\0") || seenHandles.has(output.handle)) {
      throw new TypeError(`In-process output handle ${index} is empty, duplicated, or contains NUL`);
    }
    seenHandles.add(output.handle);
    const expectedArtifactRef = `transform-host://${expected.invocation_id}/output/${output.handle}`;
    if (receipts[index]?.artifact_ref !== expectedArtifactRef) {
      throw new TypeError(`In-process output handle order differs from receipt at index ${index}`);
    }
  }
}

async function writePrivateQuarantine(
  root: string,
  result: InProcessUnisolatedResult,
  expected: ExpectedTransformInvocation,
): Promise<void> {
  const relativePaths = expected.expected_outputs.map((descriptor, index) =>
    privateRelativePath(descriptor.relative_path, index));
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new TypeError("Core expected output relative paths must be unique");
  }

  const directories = new Set<string>();
  for (const relativePath of relativePaths) {
    const parts = relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  for (const directory of [...directories].sort(byPathDepth)) {
    await mkdir(path.join(root, ...directory.split("/")), { mode: 0o700 });
  }

  for (const [index, output] of result.outputs.entries()) {
    const target = path.join(root, ...relativePaths[index]!.split("/"));
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(output.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  for (const directory of [...directories].sort(reversePathDepth)) {
    await syncDirectory(path.join(root, ...directory.split("/")));
  }
  await syncDirectory(root);
}

function privateRelativePath(value: string, index: number): string {
  if (
    value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    throw new TypeError(`Core expected output relative path ${index} is not private-relative`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new TypeError(`Core expected output relative path ${index} is not canonical`);
  }
  return value;
}

function byPathDepth(left: string, right: string): number {
  return left.split("/").length - right.split("/").length || left.localeCompare(right);
}

function reversePathDepth(left: string, right: string): number {
  return -byPathDepth(left, right);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
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
