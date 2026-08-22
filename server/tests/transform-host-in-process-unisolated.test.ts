import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { InputAssetReceipt, ResourceLimits } from "@biomed/contracts";
import { afterEach, describe, expect, test } from "vitest";

import {
  compileTransformInProcessUnisolated,
  createInProcessDatasetTransform,
  InProcessUnisolatedTransformHost,
  sha256Bytes,
  TransformBundleStore,
  type CoreAuthoritativeTransformContext,
  type CoreAuthorityClaim,
  type InProcessUnisolatedCompilationResult,
  type InProcessUnisolatedInputBytes,
} from "../src/dataset/transform-host/index.js";

const HEX_B = "b".repeat(64);
const roots: string[] = [];

const LIMITS: Readonly<ResourceLimits> = Object.freeze({
  wall_ms: 25,
  cpu_ms: 25,
  rss_bytes: 64 * 1024 * 1024,
  temp_bytes: 1024 * 1024,
  output_bytes: 1024,
  log_bytes: 4096,
  open_files: 16,
  pids: 1,
});

const SUCCESS_SOURCE = `
import { defineTransform } from "@biomed/transform-sdk/v1";
export const transform = defineTransform({
  run() {
    console.log("transform-ok");
    return { outputs: [{
      handle: "out_table",
      table_id: "table_one",
      schema_ref: "schema:one",
      locator_ref: "locator:one",
      content: "gene,value\\nTP53,1\\n",
      row_count: 1,
    }] };
  },
});
`;

const INPUT_SOURCE = `
import { defineTransform } from "@biomed/transform-sdk/v1";
export const transform = defineTransform({
  run({ inputs }) {
    const [input] = inputs;
    if (!Object.isFrozen(inputs) || !Object.isFrozen(input)) {
      throw new Error("inputs are mutable");
    }
    return { outputs: [{
      handle: "out_table",
      table_id: "table_one",
      schema_ref: "schema:one",
      locator_ref: input.receipt_kind + ":" + input.receipt_id,
      content: input.text,
      row_count: input.text.trim().split("\\n").length - 1,
    }] };
  },
});
`;

const TIMEOUT_SOURCE = `
import { defineTransform } from "@biomed/transform-sdk/v1";
export const transform = defineTransform({ run() { while (true) {} } });
`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ContextOptions {
  readonly inputHandles?: CoreAuthoritativeTransformContext["inputHandles"];
  readonly inputAssetReceipts?: readonly Readonly<InputAssetReceipt>[];
  readonly resourceLimits?: Readonly<ResourceLimits>;
}

function context(
  compiled: InProcessUnisolatedCompilationResult,
  options: ContextOptions = {},
): CoreAuthoritativeTransformContext {
  return Object.freeze({
    authorizationToken: Object.freeze({ capability: "in-process-unisolated" }),
    taskId: "task_1",
    runId: "run_1",
    buildId: "build_1",
    invocationId: "inv_1",
    attempt: 1,
    generation: 2,
    requestDigest: "a".repeat(64),
    parametersDigest: "a".repeat(64),
    familySpecDigest: "a".repeat(64),
    projectionDigest: "a".repeat(64),
    transformDescriptorDigest: "c".repeat(64),
    implementationDigest: compiled.implementationDigest,
    bundleDigest: compiled.bundleDigest,
    codeBundleRef: compiled.codeBundleRef,
    compilerDigest: compiled.compilerDigest,
    runtimeDigest: sha256Bytes(compiled.runtimeAbiVersion),
    policyDigest: compiled.policyDigest,
    resourceClassId: "fixture",
    resourceLimits: options.resourceLimits ?? LIMITS,
    deadline: "2030-01-01T00:00:00.000Z",
    cancelFence: "cancel_1",
    inputHandles: options.inputHandles ?? Object.freeze([]),
    outputHandles: Object.freeze(["out_table"]),
    inputAssetReceipts: options.inputAssetReceipts ?? Object.freeze([]),
    inputResultReceipts: Object.freeze([]),
  });
}

function claim(authority: CoreAuthoritativeTransformContext): CoreAuthorityClaim {
  return Object.freeze({
    authorizationToken: authority.authorizationToken,
    taskId: authority.taskId,
    generation: authority.generation,
  });
}

async function setup(source: string, options: ContextOptions = {}): Promise<{
  authority: CoreAuthoritativeTransformContext;
  authorityClaim: CoreAuthorityClaim;
  bundle: Awaited<ReturnType<TransformBundleStore["put"]>>;
  host: InProcessUnisolatedTransformHost;
  root: string;
  store: TransformBundleStore;
}> {
  const compiled = await compileTransformInProcessUnisolated({ source });
  const authority = context(compiled, options);
  const authorityClaim = claim(authority);
  const root = await mkdtemp(path.join(tmpdir(), "transform-unisolated-"));
  roots.push(root);
  const store = new TransformBundleStore({ root, authorityContext: authority });
  await store.initialize();
  const bundle = await store.put(authorityClaim, compiled);
  const host = new InProcessUnisolatedTransformHost({
    explicitlyEnabled: true,
    bundleStore: store,
    authorityContext: authority,
    hostImplementationDigest: HEX_B,
    now: () => new Date("2029-12-31T23:59:00.000Z"),
  });
  return { authority, authorityClaim, bundle, host, root, store };
}

function current(): boolean {
  return true;
}

function assetInput(
  handle: string,
  text: string,
): {
  readonly handle: Readonly<CoreAuthoritativeTransformContext["inputHandles"][number]>;
  readonly receipt: Readonly<InputAssetReceipt>;
  readonly request: Readonly<InProcessUnisolatedInputBytes>;
} {
  const bytes = new TextEncoder().encode(text);
  const digest = sha256Bytes(bytes);
  const receipt = Object.freeze({
    asset_id: `asset_${digest}`,
    role: "source_table",
    sha256: digest,
    size_bytes: bytes.byteLength,
    locator_ref: `registered:${digest}`,
  });
  return {
    handle: Object.freeze({
      handle,
      receiptKind: "asset",
      receiptId: receipt.asset_id,
    }),
    receipt,
    request: Object.freeze({
      handle,
      receiptKind: "asset",
      receiptId: receipt.asset_id,
      bytes,
    }),
  };
}

describe("explicit in-process unisolated Transform Host", () => {
  test("constructs a strict descriptor only from the Host-owned compilation", async () => {
    const compiled = await compileTransformInProcessUnisolated({ source: SUCCESS_SOURCE });
    const descriptor = createInProcessDatasetTransform({
      transform_id: "dynamic_transform",
      version: "1.0.0",
      entrypoint: "transform.run",
      declared_input_roles: [],
      declared_output_tables: [{ table_id: "table_one", schema_ref: "schema:one" }],
      bound_family_spec_digest: "a".repeat(64),
      bound_projection_digest: "a".repeat(64),
      determinism_profile: "deterministic",
      resource_class: "fixture",
      origin: "agent",
      scope: "task",
      review_refs: [],
    }, compiled);

    expect(descriptor).toMatchObject({
      source_digest: compiled.sourceDigest,
      bundle_digest: compiled.bundleDigest,
      code_bundle_ref: compiled.codeBundleRef,
    });
    expect(() => createInProcessDatasetTransform({
      transform_id: "dynamic_transform",
      version: "1.0.0",
      entrypoint: "transform.run",
      declared_input_roles: [],
      declared_output_tables: [{ table_id: "table_one", schema_ref: "schema:one" }],
      bound_family_spec_digest: "a".repeat(64),
      bound_projection_digest: "a".repeat(64),
      determinism_profile: "deterministic",
      resource_class: "fixture",
      origin: "agent",
      scope: "task",
      review_refs: [],
    }, { ...compiled })).toThrow(/not produced/);
  });

  test("executes only the admitted content-addressed bundle and emits an honest receipt", async () => {
    const fixture = await setup(SUCCESS_SOURCE);
    try {
      const result = await fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        isGenerationCurrent: current,
      });

      expect(result.receipt).toMatchObject({
        sandbox_backend: "in_process_unisolated",
        exit_state: "succeeded",
        transform_digest: fixture.authority.transformDescriptorDigest,
        bundle_digest: fixture.bundle.sha256,
        generation: fixture.authority.generation,
      });
      expect(result.receipt.audit_refs).toContain(
        "transform-host://inv_1/in-process-unisolated-not-security-boundary",
      );
      expect(result.stdout).toBe("transform-ok\n");
      expect(new TextDecoder().decode(result.outputs[0]?.bytes)).toBe("gene,value\nTP53,1\n");
    } finally {
      await fixture.store.dispose();
    }
  });

  test("passes exact registered asset text as an immutable SDK input", async () => {
    const input = assetInput("in_source", "gene,value\nTP53,1\n");
    const fixture = await setup(INPUT_SOURCE, {
      inputHandles: Object.freeze([input.handle]),
      inputAssetReceipts: Object.freeze([input.receipt]),
    });
    try {
      const result = await fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        inputs: Object.freeze([input.request]),
        isGenerationCurrent: current,
      });

      expect(result.receipt).toMatchObject({
        exit_state: "succeeded",
        temp_bytes: input.receipt.size_bytes,
      });
      expect(result.receipt.quarantined_output_receipts[0]?.locator_ref).toBe(
        `asset:${input.receipt.asset_id}`,
      );
      expect(new TextDecoder().decode(result.outputs[0]?.bytes)).toBe("gene,value\nTP53,1\n");
    } finally {
      await fixture.store.dispose();
    }
  });

  test("rejects mutable input containers before running admitted code", async () => {
    const input = assetInput("in_source", "gene,value\nTP53,1\n");
    const fixture = await setup(INPUT_SOURCE, {
      inputHandles: Object.freeze([input.handle]),
      inputAssetReceipts: Object.freeze([input.receipt]),
    });
    try {
      await expect(fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        inputs: [input.request],
        isGenerationCurrent: current,
      })).rejects.toMatchObject({ code: "runtime_invalid" });
      await expect(fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        inputs: Object.freeze([{ ...input.request }]),
        isGenerationCurrent: current,
      })).rejects.toMatchObject({ code: "runtime_invalid" });
    } finally {
      await fixture.store.dispose();
    }
  });

  test("rejects registered bytes that are not valid UTF-8", async () => {
    const bytes = Uint8Array.from([0xc3, 0x28]);
    const digest = sha256Bytes(bytes);
    const receipt = Object.freeze({
      asset_id: `asset_${digest}`,
      role: "source_table",
      sha256: digest,
      size_bytes: bytes.byteLength,
      locator_ref: `registered:${digest}`,
    });
    const handle = Object.freeze({
      handle: "in_source",
      receiptKind: "asset" as const,
      receiptId: receipt.asset_id,
    });
    const fixture = await setup(INPUT_SOURCE, {
      inputHandles: Object.freeze([handle]),
      inputAssetReceipts: Object.freeze([receipt]),
    });
    try {
      await expect(fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        inputs: Object.freeze([Object.freeze({
          ...handle,
          bytes,
        })]),
        isGenerationCurrent: current,
      })).rejects.toMatchObject({ code: "runtime_invalid" });
    } finally {
      await fixture.store.dispose();
    }
  });

  test("rejects input hash tampering before running admitted code", async () => {
    const input = assetInput("in_source", "gene,value\nTP53,1\n");
    const fixture = await setup(INPUT_SOURCE, {
      inputHandles: Object.freeze([input.handle]),
      inputAssetReceipts: Object.freeze([input.receipt]),
    });
    try {
      const tampered = Object.freeze({
        ...input.request,
        bytes: new TextEncoder().encode("gene,value\nTP53,2\n"),
      });
      await expect(fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        inputs: Object.freeze([tampered]),
        isGenerationCurrent: current,
      })).rejects.toMatchObject({ code: "runtime_invalid" });
    } finally {
      await fixture.store.dispose();
    }
  });

  test("rejects missing, extra, and out-of-order registered inputs", async () => {
    const first = assetInput("in_first", "gene,value\nTP53,1\n");
    const second = assetInput("in_second", "gene,value\nBRCA1,2\n");
    const fixture = await setup(INPUT_SOURCE, {
      inputHandles: Object.freeze([first.handle, second.handle]),
      inputAssetReceipts: Object.freeze([first.receipt, second.receipt]),
    });
    try {
      const execute = (inputs: readonly Readonly<InProcessUnisolatedInputBytes>[]) =>
        fixture.host.execute({
          authorityClaim: fixture.authorityClaim,
          bundle: fixture.bundle,
          inputs,
          isGenerationCurrent: current,
        });

      await expect(execute(Object.freeze([first.request]))).rejects.toMatchObject({
        code: "runtime_invalid",
      });
      await expect(execute(Object.freeze([first.request, second.request, first.request])))
        .rejects.toMatchObject({ code: "runtime_invalid" });
      await expect(execute(Object.freeze([second.request, first.request]))).rejects.toMatchObject({
        code: "runtime_invalid",
      });
    } finally {
      await fixture.store.dispose();
    }
  });

  test("rejects aggregate registered input bytes above temp_bytes", async () => {
    const input = assetInput("in_source", "gene,value\nTP53,1\n");
    const fixture = await setup(INPUT_SOURCE, {
      inputHandles: Object.freeze([input.handle]),
      inputAssetReceipts: Object.freeze([input.receipt]),
      resourceLimits: Object.freeze({ ...LIMITS, temp_bytes: input.receipt.size_bytes - 1 }),
    });
    try {
      await expect(fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        inputs: Object.freeze([input.request]),
        isGenerationCurrent: current,
      })).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    } finally {
      await fixture.store.dispose();
    }
  });

  test("returns timeout without output when synchronous admitted code exceeds wall time", async () => {
    const fixture = await setup(TIMEOUT_SOURCE);
    try {
      const result = await fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        isGenerationCurrent: current,
      });
      expect(result.receipt).toMatchObject({
        sandbox_backend: "in_process_unisolated",
        exit_state: "timeout",
        output_bytes: 0,
        quarantined_output_receipts: [],
      });
      expect(result.outputs).toEqual([]);
    } finally {
      await fixture.store.dispose();
    }
  });

  test("rechecks the retained bundle digest immediately before execution", async () => {
    const fixture = await setup(SUCCESS_SOURCE);
    try {
      const digestDirectory = path.join(fixture.root, `sha256_${fixture.bundle.sha256}`);
      const [bundleName] = (await readdir(digestDirectory)).filter((name) => name.startsWith("bundle_"));
      if (bundleName === undefined) throw new Error("stored bundle not found");
      const bundlePath = path.join(digestDirectory, bundleName);
      await chmod(bundlePath, 0o600);
      await writeFile(bundlePath, "digest mismatch");

      await expect(fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        isGenerationCurrent: current,
      })).rejects.toMatchObject({ code: "bundle_conflict" });
    } finally {
      await fixture.store.dispose();
    }
  });

  test("rejects cancelled and stale-generation invocations before execution", async () => {
    const fixture = await setup(SUCCESS_SOURCE);
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        signal: controller.signal,
        isGenerationCurrent: current,
      })).rejects.toMatchObject({ code: "invocation_cancelled" });

      await expect(fixture.host.execute({
        authorityClaim: fixture.authorityClaim,
        bundle: fixture.bundle,
        isGenerationCurrent: () => false,
      })).rejects.toMatchObject({ code: "invocation_cancelled" });
    } finally {
      await fixture.store.dispose();
    }
  });
});
