import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ResourceLimits } from "@biomed/contracts";
import { afterEach, describe, expect, test } from "vitest";

import {
  compileTransformInProcessUnisolated,
  InProcessUnisolatedTransformHost,
  sha256Bytes,
  TransformBundleStore,
  type CoreAuthoritativeTransformContext,
  type CoreAuthorityClaim,
  type InProcessUnisolatedCompilationResult,
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

const TIMEOUT_SOURCE = `
import { defineTransform } from "@biomed/transform-sdk/v1";
export const transform = defineTransform({ run() { while (true) {} } });
`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(compiled: InProcessUnisolatedCompilationResult): CoreAuthoritativeTransformContext {
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
    implementationDigest: compiled.implementationDigest,
    bundleDigest: compiled.bundleDigest,
    codeBundleRef: compiled.codeBundleRef,
    compilerDigest: compiled.compilerDigest,
    runtimeDigest: sha256Bytes(compiled.runtimeAbiVersion),
    policyDigest: compiled.policyDigest,
    resourceClassId: "fixture",
    resourceLimits: LIMITS,
    deadline: "2030-01-01T00:00:00.000Z",
    cancelFence: "cancel_1",
    inputHandles: Object.freeze([]),
    outputHandles: Object.freeze(["out_table"]),
    inputAssetReceipts: Object.freeze([]),
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

async function setup(source: string): Promise<{
  authority: CoreAuthoritativeTransformContext;
  authorityClaim: CoreAuthorityClaim;
  bundle: Awaited<ReturnType<TransformBundleStore["put"]>>;
  host: InProcessUnisolatedTransformHost;
  root: string;
  store: TransformBundleStore;
}> {
  const compiled = await compileTransformInProcessUnisolated({ source });
  const authority = context(compiled);
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

describe("explicit in-process unisolated Transform Host", () => {
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
