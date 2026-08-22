import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseDatasetTransform,
  parseTransformExecutionReceipt,
  type InputAssetReceipt,
  type ResourceLimits,
} from "@biomed/contracts";
import { afterEach, describe, expect, test } from "vitest";

import {
  compileTransformFixtureOnly,
  copyHostCompiledFixtureBytes,
  createFixtureDatasetTransform,
  detectSandboxAvailability,
  InvocationQuarantine,
  NonProductionTransformHost,
  normalizeTransformSource,
  parseTransformInvocationV1,
  sha256Bytes,
  TransformBundleStore,
  TransformHostError,
  type CoreAuthoritativeTransformContext,
  type CoreAuthorityClaim,
  type FixtureOnlyCompilationResult,
  type TransformInvocationV1,
} from "../src/dataset/transform-host/index.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

const LIMITS: Readonly<ResourceLimits> = frozen({
  wall_ms: 1_000,
  cpu_ms: 500,
  rss_bytes: 64 * 1024 * 1024,
  temp_bytes: 1024 * 1024,
  output_bytes: 1024 * 1024,
  log_bytes: 64 * 1024,
  open_files: 16,
  pids: 1,
});

interface ContextOptions {
  compilation?: FixtureOnlyCompilationResult;
  inputAssetReceipts?: readonly Readonly<InputAssetReceipt>[];
  inputHandles?: CoreAuthoritativeTransformContext["inputHandles"];
}

function authorityContext(options: ContextOptions = {}): CoreAuthoritativeTransformContext {
  const compilation = options.compilation;
  const token = frozen({ capability: "fixture-only" });
  const inputAssetReceipts = Object.freeze([...(options.inputAssetReceipts ?? [])]);
  const inputHandles = Object.freeze([...(options.inputHandles ?? [])]);
  return frozen({
    authorizationToken: token,
    taskId: "task_1",
    runId: "run_1",
    buildId: "build_1",
    invocationId: "inv_1",
    attempt: 1,
    generation: 2,
    requestDigest: HEX_A,
    parametersDigest: HEX_A,
    familySpecDigest: HEX_A,
    projectionDigest: HEX_A,
    implementationDigest: compilation?.implementationDigest ?? HEX_A,
    bundleDigest: compilation?.bundleDigest ?? HEX_A,
    codeBundleRef: compilation?.codeBundleRef ?? `bundle_${HEX_A}`,
    compilerDigest: compilation?.compilerDigest ?? HEX_A,
    runtimeDigest: sha256Bytes(compilation?.runtimeAbiVersion ?? "unavailable.1"),
    policyDigest: compilation?.policyDigest ?? HEX_A,
    resourceClassId: "fixture",
    resourceLimits: LIMITS,
    deadline: "2026-08-22T01:02:03.000Z",
    cancelFence: "cancel_1",
    inputHandles,
    outputHandles: Object.freeze([]),
    inputAssetReceipts,
    inputResultReceipts: Object.freeze([]),
  });
}

function claim(context: CoreAuthoritativeTransformContext): CoreAuthorityClaim {
  return frozen({
    authorizationToken: context.authorizationToken,
    taskId: context.taskId,
    generation: context.generation,
  });
}

function invocation(
  context: CoreAuthoritativeTransformContext,
  overrides: Partial<TransformInvocationV1> = {},
): TransformInvocationV1 {
  return {
    protocolVersion: "1.0",
    operation: "execute_transform",
    taskId: context.taskId,
    runId: context.runId,
    buildId: context.buildId,
    invocationId: context.invocationId,
    attempt: context.attempt,
    generation: context.generation,
    requestDigest: context.requestDigest,
    parametersDigest: context.parametersDigest,
    familySpecDigest: context.familySpecDigest,
    projectionDigest: context.projectionDigest,
    implementationDigest: context.implementationDigest,
    bundleDigest: context.bundleDigest,
    codeBundleRef: context.codeBundleRef,
    compilerDigest: context.compilerDigest,
    runtimeDigest: context.runtimeDigest,
    policyDigest: context.policyDigest,
    inputHandles: context.inputHandles.map((entry) => ({ ...entry })),
    outputHandles: [...context.outputHandles],
    resourceClassId: context.resourceClassId,
    deadline: context.deadline,
    cancelFence: context.cancelFence,
    ...overrides,
  };
}

function descriptorMetadata(): Parameters<typeof createFixtureDatasetTransform>[0] {
  return {
    transform_id: "transform_fixture",
    version: "1.0.0",
    entrypoint: "transform.run",
    declared_input_roles: [],
    declared_output_tables: [],
    bound_family_spec_digest: HEX_A,
    bound_projection_digest: HEX_A,
    determinism_profile: "deterministic",
    resource_class: "fixture",
    origin: "agent",
    scope: "task",
    review_refs: [],
  };
}

const VALID_SOURCE = '\uFEFFimport { defineTransform } from "@biomed/transform-sdk/v1";\r\nexport const transform = defineTransform({});\r\n';

describe("Transform Host fixture-only compilation", () => {
  test("normalizes, transpiles, and computes a Host-owned unexecutable digest closure", async () => {
    const compiled = await compileTransformFixtureOnly({ source: VALID_SOURCE });

    expect(compiled).toMatchObject({
      status: "fixture_only_unexecutable",
      executable: false,
      trustBearingAdmission: false,
      normalizedSource: 'import { defineTransform } from "@biomed/transform-sdk/v1";\nexport const transform = defineTransform({});\n',
      importedModules: ["@biomed/transform-sdk/v1"],
      codeBundleRef: `bundle_${compiled.bundleDigest}`,
    });
    expect(compiled.sourceDigest).toBe(sha256Bytes(normalizeTransformSource(VALID_SOURCE)));
    expect(compiled.implementationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(copyHostCompiledFixtureBytes(compiled).byteLength).toBe(compiled.emittedBundleSizeBytes);
  });

  test.each([
    ['import { readFile } from "node:fs";', /allowlist/],
    ['const fs = await import("node:fs");', /Dynamic module/],
    ['const run = eval("1 + 1");', /eval/],
    ['const p = process.env.SECRET;', /process/],
    ['const send = fetch("https://example.test");', /fetch/],
    ['const escape = ({})["constructor"];', /Computed property/],
  ])("rejects forbidden source: %s", async (source, message) => {
    await expect(compileTransformFixtureOnly({ source })).rejects.toThrow(message);
  });

  test("rejects caller-provided compiler/bundle/policy facts and structural result forgery", async () => {
    await expect(compileTransformFixtureOnly({
      source: VALID_SOURCE,
      allowedModules: ["node:fs"],
    })).rejects.toMatchObject({ code: "source_invalid" });
    const compiled = await compileTransformFixtureOnly({ source: VALID_SOURCE });
    expect(() => copyHostCompiledFixtureBytes({ ...compiled })).toThrow(/not produced/);
    expect(() => createFixtureDatasetTransform({
      ...descriptorMetadata() as object,
      bundle_digest: HEX_B,
    }, compiled)).toThrow(/unknown fields/);
  });

  test("builds a strict DatasetTransform descriptor only from the Host-produced capability", async () => {
    const compiled = await compileTransformFixtureOnly({ source: VALID_SOURCE });
    const descriptor = createFixtureDatasetTransform(descriptorMetadata(), compiled);

    expect(descriptor).toMatchObject({
      source_digest: compiled.sourceDigest,
      bundle_digest: compiled.bundleDigest,
      code_bundle_ref: compiled.codeBundleRef,
      dependency_closure_digest: compiled.dependencyClosureDigest,
    });
    expect(parseDatasetTransform(descriptor, "$fixture")).toEqual(descriptor);
  });
});

describe("Host-owned bundle and input snapshots", () => {
  test("stores only Host-produced bundle bytes behind a task-generation opaque handle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "transform-bundle-store-"));
    tempRoots.push(root);
    const compiled = await compileTransformFixtureOnly({ source: VALID_SOURCE });
    const context = authorityContext({ compilation: compiled });
    const store = new TransformBundleStore({ root, authorityContext: context });
    await store.initialize();

    const receipt = await store.put(claim(context), compiled);
    expect(receipt).toMatchObject({
      sha256: compiled.bundleDigest,
      implementationDigest: compiled.implementationDigest,
      generation: context.generation,
      executable: false,
      status: "fixture_only_unexecutable",
    });
    expect(receipt.handle).toMatch(/^bundle_/);
    await store.verify(claim(context), receipt);
    await expect(store.verify(claim(context), { ...receipt })).rejects.toThrow(/replaced/);
    await store.dispose();
  });

  test("copies registered bytes to a private snapshot and rejects wrong authority or symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "transform-quarantine-"));
    tempRoots.push(root);
    const registeredRoot = path.join(root, "registered");
    const quarantineRoot = path.join(root, "quarantine");
    await writeFile(path.join(root, "seed"), "seed");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(registeredRoot));
    const inputPath = path.join(registeredRoot, "input.tsv");
    const bytes = Buffer.from("gene\tvalue\nTP53\t1\n", "utf8");
    await writeFile(inputPath, bytes);
    const digest = sha256Bytes(bytes);
    const assetId = `asset_${digest}`;
    const assetReceipt = frozen({
      asset_id: assetId,
      role: "source",
      sha256: digest,
      size_bytes: bytes.byteLength,
      locator_ref: "receipt:asset:source",
    });
    const inputHandle = frozen({
      handle: "in_source",
      receiptKind: "asset" as const,
      receiptId: assetId,
    });
    const context = authorityContext({
      inputAssetReceipts: [assetReceipt],
      inputHandles: [inputHandle],
    });
    const quarantine = new InvocationQuarantine({
      quarantineRoot,
      registeredInputRoot: registeredRoot,
      authorityContext: context,
    });
    await quarantine.initialize();

    const receipt = await quarantine.registerInput(claim(context), {
      receiptKind: "asset",
      receiptId: assetId,
      relativePath: "input.tsv",
    });
    expect(receipt.handle).toMatch(/^in_/);
    expect(receipt).not.toHaveProperty("absolutePath");
    await writeFile(inputPath, "mutated source bytes");
    await quarantine.verifyInputSnapshot(claim(context), receipt);
    expect(quarantine.declareOutput(claim(context), "table.csv")).toMatchObject({
      generation: context.generation,
      handle: expect.stringMatching(/^out_/),
    });
    expect(() => quarantine.declareOutput(claim(context), "TABLE.csv")).toThrow(/collide/);
    expect(() => quarantine.declareOutput(claim(context), "NUL")).toThrow(/portable/);
    await expect(quarantine.verifyInputSnapshot(claim(context), { ...receipt })).rejects.toThrow(/replaced/);
    await expect(quarantine.verifyInputSnapshot(frozen({
      ...claim(context),
      taskId: "task_other",
    }), receipt)).rejects.toThrow(/Core-authoritative/);

    const linkPath = path.join(registeredRoot, "link.tsv");
    try {
      await symlink(inputPath, linkPath, "file");
      await expect(quarantine.registerInput(claim(context), {
        receiptKind: "asset",
        receiptId: assetId,
        relativePath: "link.tsv",
      })).rejects.toThrow(/symlink|junction/);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    }

    const hardlinkPath = path.join(registeredRoot, "hardlink.tsv");
    try {
      await link(inputPath, hardlinkPath);
      await expect(quarantine.registerInput(claim(context), {
        receiptKind: "asset",
        receiptId: assetId,
        relativePath: "hardlink.tsv",
      })).rejects.toThrow(/hardlink/);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    }
    await quarantine.dispose();
  });
});

describe("versioned permanently-disabled Host protocol", () => {
  test("reports sandbox_unavailable honestly on every platform and issues no output", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(detectSandboxAvailability(platform)).toMatchObject({
        available: false,
        reason: "sandbox_unavailable",
        platform,
      });
    }

    const context = authorityContext();
    const result = new NonProductionTransformHost({
      hostImplementationDigest: HEX_B,
      authorityContext: context,
      platform: "win32",
      now: () => new Date("2026-08-22T00:00:00Z"),
    }).execute({
      invocation: invocation(context),
      authorityClaim: claim(context),
    });

    expect(result.sandbox.available).toBe(false);
    expect(result.terminal.reason).toBe("sandbox_unavailable");
    expect(result.receipt).toMatchObject({
      sandbox_backend: "unavailable",
      exit_state: "sandbox_unavailable",
      exit_code: null,
      exit_signal: null,
      output_bytes: 0,
      quarantined_output_receipts: [],
      granted_capabilities: [],
    });
    expect(parseTransformExecutionReceipt(result.receipt, "$receipt")).toEqual(result.receipt);
  });

  test("rejects Core context and claim accessors or proxies without invoking them", () => {
    const validContext = authorityContext();
    let reads = 0;
    const accessorContext = { ...validContext };
    Object.defineProperty(accessorContext, "taskId", {
      enumerable: true,
      get() {
        reads += 1;
        return "task_1";
      },
    });
    Object.freeze(accessorContext);
    expect(() => new NonProductionTransformHost({
      hostImplementationDigest: HEX_B,
      authorityContext: accessorContext,
    })).toThrow(/data property/);
    expect(reads).toBe(0);

    const proxyContext = new Proxy(validContext, {
      get() {
        reads += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        reads += 1;
        return undefined;
      },
      getPrototypeOf() {
        reads += 1;
        return Object.prototype;
      },
      ownKeys() {
        reads += 1;
        return [];
      },
    });
    expect(() => new NonProductionTransformHost({
      hostImplementationDigest: HEX_B,
      authorityContext: proxyContext,
    })).toThrow(/non-Proxy/);
    expect(reads).toBe(0);

    const host = new NonProductionTransformHost({
      hostImplementationDigest: HEX_B,
      authorityContext: validContext,
      now: () => new Date("2026-08-22T00:00:00Z"),
    });
    const accessorClaim = { ...claim(validContext) };
    Object.defineProperty(accessorClaim, "taskId", {
      enumerable: true,
      get() {
        reads += 1;
        return "task_1";
      },
    });
    Object.freeze(accessorClaim);
    expect(() => host.execute({
      invocation: invocation(validContext),
      authorityClaim: accessorClaim,
    })).toThrow(/data property/);
    expect(reads).toBe(0);
  });

  test("rejects protocol smuggling, duplicate handles, and wrong authority", () => {
    const context = authorityContext();
    expect(() => parseTransformInvocationV1({
      ...invocation(context),
      production: true,
    })).toThrow(/unknown fields/);
    expect(() => parseTransformInvocationV1({
      ...invocation(context),
      protocolVersion: "2.0",
    })).toThrow(/protocolVersion/);
    expect(() => parseTransformInvocationV1(invocation(context, {
      inputHandles: [
        { handle: "in_1", receiptKind: "asset", receiptId: "asset_1" },
        { handle: "in_1", receiptKind: "asset", receiptId: "asset_2" },
      ],
    }))).toThrow(/duplicate opaque handles/);

    const host = new NonProductionTransformHost({
      hostImplementationDigest: HEX_B,
      authorityContext: context,
      platform: "win32",
      now: () => new Date("2026-08-22T00:00:00Z"),
    });
    expect(() => host.execute({
      invocation: invocation(context),
      authorityClaim: { ...claim(context), generation: context.generation + 1 },
    })).toThrowError(TransformHostError);
  });
});
