import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoreAcquisitionRequest, WorkflowRecipeRef } from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquisitionRequestIdentity,
  CoreAcquisitionError,
  CoreAcquisitionRegistry,
  CoreAcquisitionRuntime,
  type AcquisitionProviderHandler,
} from "../src/dataset/acquisition/runtime.js";
import { ContentCache } from "../src/external/acquisition/content-cache.js";
import { PublicHttpClient, type RequestExecutor } from "../src/external/network/http-client.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const roots: string[] = [];
const URL = "https://fixture.example/data.tsv";
const CONTENT = "gene\tvalue\nEGFR\t1\n";
const SHA256 = createHash("sha256").update(CONTENT).digest("hex");
const IMPLEMENTATION_DIGEST = "a".repeat(64);

function request(overrides: Partial<CoreAcquisitionRequest> = {}): CoreAcquisitionRequest {
  return {
    schema_version: "1.0",
    request_id: "request_c2i",
    task_id: "task_c2i",
    build_id: "build_c2i",
    binding_id: "binding_fixture",
    mode: "builtin",
    provider_id: "fixture_provider",
    recipe_id: null,
    recipe_version: null,
    parameters: { accession: "EGFR", nested: { page: 1 } },
    ...overrides,
  };
}

function provider(): AcquisitionProviderHandler {
  return {
    providerId: "fixture_provider",
    implementationDigest: IMPLEMENTATION_DIGEST,
    plan: () => ({
      source: {
        schema_version: "1.0",
        source_id: "source_fixture",
        database: "browser",
        accession: "EGFR",
        url: URL,
        title: "fixture",
        retrieved_at: "2026-08-18T00:00:00.000Z",
      },
      filename: "data.tsv",
      dataLevel: "repository_processed",
      maxBytes: 1024,
      expectedSha256: SHA256,
      expectedMediaTypes: new Set(["text/tab-separated-values"]),
      allowedHosts: new Set(["fixture.example"]),
    }),
  };
}

function recipe(status: WorkflowRecipeRef["status"] = "PROMOTED"): WorkflowRecipeRef {
  return {
    schema_version: "1.0",
    recipe_id: "fixture_recipe",
    recipe_version: 1,
    status,
    implementation_digest: IMPLEMENTATION_DIGEST,
  };
}

function client(executor: RequestExecutor): PublicHttpClient {
  return new PublicHttpClient({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    executor,
  });
}

async function runtime(options: { executor: RequestExecutor; registry?: CoreAcquisitionRegistry }): Promise<{
  root: string;
  runtime: CoreAcquisitionRuntime;
  assets: SourceAssetRegistry;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2i-"));
  roots.push(root);
  const registry = options.registry ?? new CoreAcquisitionRegistry();
  if (options.registry === undefined) registry.registerProvider(provider());
  const assets = new SourceAssetRegistry("task_c2i", root, {
    now: () => new Date("2026-08-18T00:00:00.000Z"),
  });
  return {
    root,
    assets,
    runtime: new CoreAcquisitionRuntime({
      taskId: "task_c2i",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: client(options.executor),
      sourceAssetRegistry: assets,
      registry,
      maxAttempts: 3,
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TASK-C2I Core-owned acquisition", () => {
  it("executes a fixed builtin provider and registers an immutable source asset", async () => {
    let calls = 0;
    const fixture = await runtime({
      executor: async () => {
        calls += 1;
        return {
          status: 200,
          headers: { "content-type": "text/tab-separated-values", "content-length": String(Buffer.byteLength(CONTENT)) },
          body: (async function* (): AsyncIterable<Buffer> { yield Buffer.from(CONTENT); })(),
        };
      },
    });

    const result = await fixture.runtime.acquire(request());
    expect(result.requestIdentityDigest).toBe(acquisitionRequestIdentity(request(), IMPLEMENTATION_DIGEST));
    expect(result.sourceAsset).toEqual({
      schema_version: "1.0",
      asset_id: `asset_${SHA256}`,
      task_id: "task_c2i",
      role: "source",
    });
    expect(result.extractionAssets).toEqual([]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ status: "succeeded", attempt_number: 1, retryable: false });

    const resolved = await fixture.assets.resolve(result.sourceAsset.asset_id);
    expect(resolved.registration_receipt).toMatchObject({ sha256: SHA256, task_id: "task_c2i" });
    await expect(fixture.assets.resolveCoreAcquired(result.sourceAsset.asset_id)).resolves.toMatchObject({
      acquisition_provenance: {
        provider_id: "fixture_provider",
        implementation_digest: IMPLEMENTATION_DIGEST,
        request_identity_digest: result.requestIdentityDigest,
      },
    });

    const second = await fixture.runtime.acquire({
      ...request(),
      request_id: "request_second",
      build_id: "build_second",
    });
    expect(second.sourceAsset?.asset_id).toBe(result.sourceAsset.asset_id);
    expect(second.requestIdentityDigest).not.toBe(result.requestIdentityDigest);
    await expect(fixture.assets.resolveCoreAcquired(
      result.sourceAsset.asset_id,
      second.requestIdentityDigest,
    )).resolves.toMatchObject({
      acquisition_provenance: { request_identity_digest: second.requestIdentityDigest },
    });
    await expect(fixture.assets.resolveCoreAcquired(result.sourceAsset.asset_id))
      .rejects.toThrow(/ambiguous Core acquisition provenance/);
    const chunks: Buffer[] = [];
    for await (const chunk of resolved.content) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(CONTENT));
    expect(calls).toBe(1);
  });

  it("resumes a retry and then reuses downloader cache with stable lineage", async () => {
    let calls = 0;
    const fixture = await runtime({
      executor: async ({ headers }) => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 200,
            headers: { "content-type": "text/tab-separated-values" } as Record<string, string>,
            body: (async function* (): AsyncIterable<Buffer> {
              yield Buffer.from(CONTENT.slice(0, 5));
              throw new Error("socket reset");
            })(),
          };
        }
        expect(headers.Range).toBe("bytes=5-");
        const remainder = CONTENT.slice(5);
        return {
          status: 206,
          headers: { "content-type": "text/tab-separated-values", "content-length": String(Buffer.byteLength(remainder)) },
          body: (async function* (): AsyncIterable<Buffer> { yield Buffer.from(remainder); })(),
        };
      },
    });

    const first = await fixture.runtime.acquire(request());
    expect(first.attempts).toHaveLength(2);
    expect(first.attempts[0]).toMatchObject({ status: "failed", retryable: true });
    expect(first.attempts[1]?.cache_lineage).toMatchObject({
      request_identity_digest: first.requestIdentityDigest,
      resumed_from_attempt_id: first.attempts[0]?.attempt_id,
      part_relative_path: `source_assets/.acquisition/${first.requestIdentityDigest}.part`,
      cache_blob_sha256: SHA256,
    });

    const second = await fixture.runtime.acquire(request({ request_id: "request_c2i_repeat" }));
    expect(second.requestIdentityDigest).toBe(first.requestIdentityDigest);
    expect(second.attempts).toHaveLength(1);
    expect(second.sourceAsset.asset_id).toBe(first.sourceAsset.asset_id);
    expect(calls).toBe(2);
    const durable = JSON.parse(await readFile(path.join(fixture.root, "state", "core-acquisition-attempts.json"), "utf8")) as unknown[];
    expect(durable).toHaveLength(3);
  });

  it("preserves the terminal provider error after bounded retries", async () => {
    const fixture = await runtime({
      executor: async () => {
        throw new Error("socket unavailable");
      },
    });

    const failure = await fixture.runtime.acquire(request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreAcquisitionError);
    expect(failure).toMatchObject({
      name: "CoreAcquisitionError",
      message: "acquisition failed: internal_error",
      retryable: false,
      details: {
        provider_id: "fixture_provider",
        error_code: "internal_error",
        attempts: 3,
      },
    });
  });

  it("accepts only a registered PROMOTED recipe and rejects unknown providers", async () => {
    const registry = new CoreAcquisitionRegistry();
    registry.registerProvider(provider());
    expect(() => registry.registerRecipe({ ref: recipe("DRAFT"), providerId: "fixture_provider" })).toThrow(/PROMOTED/);
    expect(() => registry.registerRecipe({ ref: recipe("RETIRED"), providerId: "fixture_provider" })).toThrow(/PROMOTED/);
    registry.registerRecipe({ ref: recipe(), providerId: "fixture_provider" });

    const fixture = await runtime({
      registry,
      executor: async () => ({
        status: 200,
        headers: { "content-type": "text/tab-separated-values", "content-length": String(Buffer.byteLength(CONTENT)) },
        body: (async function* (): AsyncIterable<Buffer> { yield Buffer.from(CONTENT); })(),
      }),
    });
    await expect(fixture.runtime.acquire(request({ provider_id: "missing_provider" }))).rejects.toThrow(/not registered/);
    await expect(fixture.runtime.acquire(request({
      mode: "workflow_recipe",
      provider_id: null,
      recipe_id: "fixture_recipe",
      recipe_version: 1,
    }))).resolves.toMatchObject({ sourceAsset: { task_id: "task_c2i" } });
    await expect(fixture.runtime.acquire(request({
      mode: "workflow_recipe",
      provider_id: null,
      recipe_id: "missing_recipe",
      recipe_version: 1,
    }))).rejects.toThrow(/PROMOTED/);
  });

  it.each<Record<string, import("@biomed/contracts").JsonValue>>([
    { agent_code: "fetch('https://evil.example')" },
    { output_path: "../workspace/stolen.tsv" },
    { filename: "C:\\temp\\stolen.tsv" },
  ])("rejects Agent code and arbitrary path parameters", async (parameters) => {
    const fixture = await runtime({
      executor: async () => { throw new Error("must not execute"); },
    });
    await expect(fixture.runtime.acquire(request({ parameters }))).rejects.toThrow(/code or paths|arbitrary paths/);
  });

  it("rejects cross-task requests and detects registered asset hash drift", async () => {
    const fixture = await runtime({
      executor: async () => ({
        status: 200,
        headers: { "content-type": "text/tab-separated-values", "content-length": String(Buffer.byteLength(CONTENT)) },
        body: (async function* (): AsyncIterable<Buffer> { yield Buffer.from(CONTENT); })(),
      }),
    });
    await expect(fixture.runtime.acquire(request({ task_id: "task_other" }))).rejects.toThrow(/different task/);
    const acquired = await fixture.runtime.acquire(request());
    const resolved = await fixture.assets.resolve(acquired.sourceAsset.asset_id);
    await writeFile(path.join(fixture.root, resolved.registration_receipt.relative_path), CONTENT.replace("EGFR", "KRAS"));
    await expect(async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of resolved.content) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    }).rejects.toThrow(/hash drift/);
  });
});
