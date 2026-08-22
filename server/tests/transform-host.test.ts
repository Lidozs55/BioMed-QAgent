import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseTransformExecutionReceipt,
  type DatasetTransform,
  type InputAssetReceipt,
} from "@biomed/contracts";
import { afterEach, describe, expect, test } from "vitest";

import {
  admitTransformBundle,
  admitTransformSource,
  InvocationQuarantine,
  NonProductionTransformHost,
  normalizeTransformSource,
  parseTransformInvocationV1,
  sha256Bytes,
  TRANSFORM_HOST_POLICY_VERSION,
  TRANSFORM_RUNTIME_ABI_VERSION,
  TransformBundleStore,
  TransformHostError,
  type TransformInvocationV1,
} from "../src/dataset/transform-host/index.js";

const HEX = "a".repeat(64);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function descriptor(source: string, bundle: Uint8Array): DatasetTransform {
  const sourceDigest = sha256Bytes(normalizeTransformSource(source));
  const bundleDigest = sha256Bytes(bundle);
  return {
    transform_id: "t_fixture",
    version: "1.0.0",
    source_digest: sourceDigest,
    bundle_digest: bundleDigest,
    compiler_id: "tsc",
    compiler_version: "5.6.3",
    compiler_options_digest: HEX,
    runtime_abi_version: TRANSFORM_RUNTIME_ABI_VERSION,
    runtime_policy_version: TRANSFORM_HOST_POLICY_VERSION,
    dependency_closure_digest: HEX,
    code_bundle_ref: `bundle_${bundleDigest}`,
    entrypoint: "transform.run",
    declared_input_roles: [],
    declared_output_tables: [],
    bound_family_spec_digest: HEX,
    determinism_profile: "deterministic",
    resource_class: "fixture",
    origin: "agent",
    scope: "task",
    review_refs: [],
  };
}

function invocation(overrides: Partial<TransformInvocationV1> = {}): TransformInvocationV1 {
  return {
    protocolVersion: "1.0",
    operation: "execute_transform",
    taskId: "task_1",
    runId: "run_1",
    buildId: "build_1",
    invocationId: "inv_1",
    attempt: 1,
    generation: 2,
    familySpecDigest: HEX,
    projectionDigest: HEX,
    implementationDigest: HEX,
    bundleDigest: HEX,
    compilerDigest: HEX,
    runtimeDigest: HEX,
    policyDigest: HEX,
    inputHandles: [],
    outputHandles: [],
    resourceLimits: {
      cpu_ms: 1_000,
      rss_bytes: 64 * 1024 * 1024,
      temp_bytes: 1024,
      output_bytes: 1024,
      open_files: 16,
    },
    deadline: "2026-08-22T01:02:03.000Z",
    ...overrides,
  };
}

describe("Transform Host source and content admission", () => {
  test("normalizes source before hashing and binds exact bundle/implementation bytes", async () => {
    const source = '\uFEFFimport { defineTransform } from "@biomed/transform-sdk/v1";\r\nexport const café = defineTransform({});\r\n';
    const bundle = new TextEncoder().encode("export const bundled = true;\n");
    const admitted = await admitTransformBundle({
      descriptor: descriptor(source, bundle),
      source,
      emittedBundle: bundle,
      compilerOptionsDigest: HEX,
      dependencyClosureDigest: HEX,
    });

    expect(admitted.normalizedSource).toBe(
      'import { defineTransform } from "@biomed/transform-sdk/v1";\nexport const café = defineTransform({});\n',
    );
    expect(admitted.importedModules).toEqual(["@biomed/transform-sdk/v1"]);
    expect(admitted.implementationDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ['import { readFile } from "node:fs";', /allowlist/],
    ['const fs = await import("node:fs");', /Dynamic import/],
    ['const run = eval("1 + 1");', /eval/],
    ['const p = process.env.SECRET;', /process/],
    ['const send = fetch("https://example.test");', /fetch/],
  ])("rejects forbidden source: %s", (source, message) => {
    expect(() => admitTransformSource(source)).toThrow(message);
  });

  test("rejects Agent-declared digest drift", async () => {
    const source = "export const transform = 1;\n";
    const bundle = new TextEncoder().encode("export const transform = 1;\n");
    const bad = { ...descriptor(source, bundle), source_digest: "b".repeat(64) };
    await expect(admitTransformBundle({
      descriptor: bad,
      source,
      emittedBundle: bundle,
      compilerOptionsDigest: HEX,
      dependencyClosureDigest: HEX,
    })).rejects.toMatchObject({ code: "descriptor_mismatch" });
  });

  test("stores admitted bundles under an immutable content address", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "transform-bundles-"));
    tempRoots.push(root);
    const source = "export const transform = 1;\n";
    const bundle = new TextEncoder().encode("export const transform = 1;\n");
    const admitted = await admitTransformBundle({
      descriptor: descriptor(source, bundle),
      source,
      emittedBundle: bundle,
      compilerOptionsDigest: HEX,
      dependencyClosureDigest: HEX,
    });
    const stored = await new TransformBundleStore(root).put(admitted);

    expect(stored.ref).toBe(`bundle_${admitted.bundleDigest}`);
    expect(await readFile(path.join(root, `${stored.ref}.mjs`), "utf8")).toBe(
      "export const transform = 1;\n",
    );
    await chmod(path.join(root, `${stored.ref}.mjs`), 0o600);
    await writeFile(path.join(root, `${stored.ref}.mjs`), "corrupt");
    await expect(new TransformBundleStore(root).put(admitted)).rejects.toMatchObject({
      code: "bundle_conflict",
    });
  });
});

describe("opaque invocation quarantine", () => {
  test("admits exact task-owned bytes and exposes only opaque handles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "transform-quarantine-"));
    tempRoots.push(root);
    const inputPath = path.join(root, "registered.tsv");
    await writeFile(inputPath, "gene\tvalue\nTP53\t1\n");
    const bytes = await readFile(inputPath);
    const quarantine = new InvocationQuarantine(path.join(root, "host"), "task_1", "inv_1");
    await quarantine.initialize();
    const receipt = await quarantine.registerInput({
      taskId: "task_1",
      assetId: "asset_1",
      role: "source",
      absolutePath: inputPath,
      sha256: sha256Bytes(bytes),
      sizeBytes: bytes.byteLength,
    });
    const output = quarantine.declareOutput("table.csv");

    expect(receipt.handle).toBe("in_1");
    expect(receipt).not.toHaveProperty("absolutePath");
    expect(output).toEqual({ handle: "out_1" });
    expect(() => quarantine.resolveInputForBackend("../registered.tsv")).toThrow(/Unknown opaque input/);
    await quarantine.verifyInputUnchanged(receipt);
  });

  test("rejects a wrong-task receipt, byte drift, and symlink input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "transform-quarantine-reject-"));
    tempRoots.push(root);
    const inputPath = path.join(root, "registered.tsv");
    await writeFile(inputPath, "one");
    const quarantine = new InvocationQuarantine(path.join(root, "host"), "task_1", "inv_1");
    await quarantine.initialize();
    await expect(quarantine.registerInput({
      taskId: "task_other",
      assetId: "asset_1",
      role: "source",
      absolutePath: inputPath,
      sha256: sha256Bytes("one"),
      sizeBytes: 3,
    })).rejects.toMatchObject({ code: "quarantine_violation" });
    await expect(quarantine.registerInput({
      taskId: "task_1",
      assetId: "asset_1",
      role: "source",
      absolutePath: inputPath,
      sha256: sha256Bytes("two"),
      sizeBytes: 3,
    })).rejects.toMatchObject({ code: "quarantine_violation" });

    const linkPath = path.join(root, "linked.tsv");
    try {
      await symlink(inputPath, linkPath, "file");
      await expect(quarantine.registerInput({
        taskId: "task_1",
        assetId: "asset_1",
        role: "source",
        absolutePath: linkPath,
        sha256: sha256Bytes("one"),
        sizeBytes: 3,
      })).rejects.toMatchObject({ code: "quarantine_violation" });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    }
  });
});

describe("versioned disabled Host protocol", () => {
  test("fails closed as sandbox_unavailable on Windows and issues a parseable receipt", () => {
    const asset: InputAssetReceipt = {
      asset_id: "asset_1",
      role: "source",
      sha256: HEX,
      size_bytes: 10,
    };
    const request = invocation({
      inputHandles: [{ handle: "in_1", receiptKind: "asset", receiptId: "asset_1" }],
    });
    const result = new NonProductionTransformHost({
      hostImplementationDigest: "b".repeat(64),
      platform: "win32",
      now: () => new Date("2026-08-22T00:00:00Z"),
    }).execute({ invocation: request, inputAssetReceipts: [asset], inputResultReceipts: [] });

    expect(result.sandbox).toMatchObject({ available: false, reason: "sandbox_unavailable", platform: "win32" });
    expect(result.terminal.reason).toBe("sandbox_unavailable");
    expect(result.receipt.exit_state).toBe("sandbox_unavailable");
    expect(result.receipt.granted_capabilities).toEqual([]);
    expect(result.receipt.quarantined_output_receipts).toEqual([]);
    expect(parseTransformExecutionReceipt(result.receipt, "$").exit_state).toBe("sandbox_unavailable");
  });

  test("rejects unknown protocol fields, versions, duplicate handles, and receipt mismatch", () => {
    expect(() => parseTransformInvocationV1({ ...invocation(), production: true })).toThrow(/unknown fields/);
    expect(() => parseTransformInvocationV1({ ...invocation(), protocolVersion: "2.0" })).toThrow(/protocolVersion/);
    expect(() => parseTransformInvocationV1(invocation({
      inputHandles: [
        { handle: "in_1", receiptKind: "asset", receiptId: "asset_1" },
        { handle: "in_1", receiptKind: "asset", receiptId: "asset_2" },
      ],
    }))).toThrow(/duplicate opaque handles/);

    const host = new NonProductionTransformHost({ hostImplementationDigest: HEX, platform: "win32" });
    expect(() => host.execute({
      invocation: invocation({
        inputHandles: [{ handle: "in_1", receiptKind: "asset", receiptId: "asset_expected" }],
      }),
      inputAssetReceipts: [{ asset_id: "asset_other", role: "source", sha256: HEX, size_bytes: 1 }],
      inputResultReceipts: [],
    })).toThrowError(TransformHostError);
  });
});
