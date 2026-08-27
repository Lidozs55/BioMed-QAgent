import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256FileStream } from "../src/dataset/adapters/hashing.js";
import { OperationAbortedError } from "../src/dataset/cooperative.js";
import {
  loadOperationOutput,
  saveOperationOutput,
  sha256Json,
  stageOutputFile,
  type OperationOutputEnvelope,
} from "../src/dataset/runtime/checkpoint.js";
import { checkRuntimeParity, scratchOutputRoot } from "./runtime-parity.js";

// T6 regression lock: wrap the streaming hash so the same module instance is
// shared by the test and checkpoint.ts, letting us assert a large file is
// verified via the streaming path (never read whole into memory).
vi.mock("../src/dataset/adapters/hashing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dataset/adapters/hashing.js")>();
  return { ...actual, sha256FileStream: vi.fn(actual.sha256FileStream) };
});

describe("Phase 4 step 10 runtime parity", () => {
  test("executor plan/reuse/cancel/recovery mirror test_dataset_runtime.py", async () => {
    expect(await checkRuntimeParity({ outputRoot: scratchOutputRoot("runtime-vitest-") })).toEqual([]);
  }, 120_000);
});

async function writeVerifiedEnvelope(root: string): Promise<{
  stateDir: string;
  taskRoot: string;
  envelope: OperationOutputEnvelope;
  filePath: string;
}> {
  const taskRoot = join(root, "task");
  const stateDir = join(taskRoot, "state");
  await mkdir(taskRoot, { recursive: true });
  const filePath = join(taskRoot, "canonical_expression.csv");
  const content = "PROBE1\tTP53\t1.5\nPROBE2\tBRCA1\t2.5\n";
  await writeFile(filePath, content, "utf8");
  const sha256 = await sha256FileStream(filePath);
  const output: Record<string, unknown> = { rows: 2, columns: ["probe", "symbol", "value"] };
  const envelope: OperationOutputEnvelope = {
    task_id: "task_a5i",
    requirement_id: "build_a5i",
    operation_id: "canonicalize:binding_geo",
    operation_attempt_id: "attempt_1",
    output_digest: sha256Json(output),
    output_sha256: sha256Json(output),
    output,
    files: [stageOutputFile("canonical_expression.csv", Buffer.byteLength(content), sha256)],
  };
  saveOperationOutput(stateDir, envelope);
  return { stateDir, taskRoot, envelope, filePath };
}

function loadOptions(taskRoot: string, envelope: OperationOutputEnvelope): {
  taskRoot: string;
  taskId: string;
  requirementId: string;
  operationId: string;
  operationAttemptId: string;
  outputDigest: string;
} {
  return {
    taskRoot,
    taskId: envelope.task_id,
    requirementId: envelope.requirement_id,
    operationId: envelope.operation_id,
    operationAttemptId: envelope.operation_attempt_id,
    outputDigest: envelope.output_digest,
  };
}

describe("loadOperationOutput streaming verification", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("returns the output when the file receipt verifies", async () => {
    const root = await mkdtemp(join(tmpdir(), "biomed-opout-ok-"));
    roots.push(root);
    const { stateDir, taskRoot, envelope } = await writeVerifiedEnvelope(root);
    expect(await loadOperationOutput(stateDir, loadOptions(taskRoot, envelope))).toEqual(envelope.output);
  });

  test("tampering the referenced file (same size) fails closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "biomed-opout-tamper-"));
    roots.push(root);
    const { stateDir, taskRoot, envelope, filePath } = await writeVerifiedEnvelope(root);
    const bytes = Buffer.from(await readFile(filePath));
    bytes[0] = bytes[0] === 0x50 ? 0x51 : 0x50;
    await writeFile(filePath, bytes);
    expect(await loadOperationOutput(stateDir, loadOptions(taskRoot, envelope))).toBeNull();
  });

  test("large file receipts are verified by streaming, not whole-file read", async () => {
    const root = await mkdtemp(join(tmpdir(), "biomed-opout-stream-"));
    roots.push(root);
    const taskRoot = join(root, "task");
    const stateDir = join(taskRoot, "state");
    await mkdir(taskRoot, { recursive: true });
    const filePath = join(taskRoot, "canonical_expression.csv");
    await writeFile(filePath, Buffer.alloc(8 * 1024 * 1024, 0x41));
    const sha256 = await sha256FileStream(filePath);
    const output: Record<string, unknown> = { rows: 4 * 1024 * 1024, columns: ["a", "b", "c"] };
    const envelope: OperationOutputEnvelope = {
      task_id: "task_a5i",
      requirement_id: "build_a5i",
      operation_id: "canonicalize:binding_geo",
      operation_attempt_id: "attempt_1",
      output_digest: sha256Json(output),
      output_sha256: sha256Json(output),
      output,
      files: [stageOutputFile("canonical_expression.csv", 8 * 1024 * 1024, sha256)],
    };
    saveOperationOutput(stateDir, envelope);

    // Regression lock (T6): a large file must be verified via the streaming
    // hash (createReadStream), never by reading the whole file into memory.
    // Only the load path's internal call (not our own digest computation)
    // may hash the .csv, so clear the wrapper before invoking it.
    const sha256Spy = vi.mocked(sha256FileStream);
    sha256Spy.mockClear();
    expect(await loadOperationOutput(stateDir, loadOptions(taskRoot, envelope))).toEqual(output);
    expect(sha256Spy.mock.calls.some((call) => String(call[0]).endsWith(".csv"))).toBe(true);
  });

  test("a cancelled signal aborts verification instead of failing closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "biomed-opout-abort-"));
    roots.push(root);
    const { stateDir, taskRoot, envelope } = await writeVerifiedEnvelope(root);
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadOperationOutput(stateDir, loadOptions(taskRoot, envelope), controller.signal),
    ).rejects.toBeInstanceOf(OperationAbortedError);
  });
});