/**
 * GMRepo fixed provider + POST acquisition path tests.
 *
 * Reproduction (RED): the trusted acquisition downloader is GET-only by
 * default — a POST-only endpoint (like GMRepo's official API) returns
 * ``HTTP 405`` through the GET path and is recorded as no-data, even though
 * the same endpoint serves the payload to a POST with the right JSON body.
 *
 * Fix (GREEN): the ``gmrepo.files.v1`` plan carries the POST method/body
 * inside the trusted provider contract; the downloader sends it through the
 * same policy-pinned transport (HTTPS, exact-host allowlist, hashing, size
 * limits, media-type checks, content cache) and CoreAcquisitionRuntime
 * registers the verified bytes with hash/provenance. POST never resumes
 * (no Range), and distinct POST bodies on the same URL never share a cache
 * entry.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  CoreAcquisitionError,
  CoreAcquisitionRegistry,
  CoreAcquisitionRuntime,
  type AcquisitionProviderHandler,
} from "../src/dataset/acquisition/runtime.js";
import {
  GMREPO_FILES_IMPLEMENTATION_DIGEST,
  GMREPO_FILES_PROVIDER_ID,
  createGmrepoFilesProvider,
} from "../src/dataset/acquisition/gmrepo-provider.js";
import { ContentCache } from "../src/external/acquisition/content-cache.js";
import { PublicHttpClient, type RequestExecutor } from "../src/external/network/http-client.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const roots: string[] = [];
const HOST = "gmrepo.humangut.info";
const ENDPOINT = `https://${HOST}/api/getAssociatedSpeciesByMeshID`;
const MESH_HEALTH = "D006262";
const MESH_UC = "D003093";

const SPECIES_PAYLOAD = (meshId: string): string => JSON.stringify({
  mesh_id: meshId,
  nr_valid_samples: 1234,
  associated_species: [
    { ncbi_taxon_id: 40520, scientific_name: "Blautia obeum", samples: 1123 },
    { ncbi_taxon_id: 562, scientific_name: "Escherichia coli", samples: 89 },
  ],
});

function request(meshId: string): CoreAcquisitionRequest {
  return {
    schema_version: "1.0",
    request_id: `request_gmrepo_${meshId}`,
    task_id: "task_gmrepo",
    build_id: "build_gmrepo",
    binding_id: "binding_gmrepo",
    mode: "builtin",
    provider_id: GMREPO_FILES_PROVIDER_ID,
    recipe_id: null,
    recipe_version: null,
    parameters: { source: "gmrepo", accession: meshId, entities: {} },
  };
}

function client(executor: RequestExecutor): PublicHttpClient {
  return new PublicHttpClient({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    executor,
  });
}

async function fixture(options: {
  executor: RequestExecutor;
  registry?: CoreAcquisitionRegistry;
}): Promise<{ root: string; runtime: CoreAcquisitionRuntime; assets: SourceAssetRegistry }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gmrepo-"));
  roots.push(root);
  const registry = options.registry ?? new CoreAcquisitionRegistry();
  if (options.registry === undefined) registry.registerProvider(createGmrepoFilesProvider());
  const assets = new SourceAssetRegistry("task_gmrepo", root, {
    now: () => new Date("2026-08-26T00:00:00.000Z"),
  });
  return {
    root,
    assets,
    runtime: new CoreAcquisitionRuntime({
      taskId: "task_gmrepo",
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

/** Simulates the GMRepo official API: GET is rejected, POST + JSON body returns data. */
function gmrepoExecutor(log: Array<{ method: string; body: string | null; url: string }> = []): RequestExecutor {
  return async (request) => {
    log.push({
      method: request.method,
      body: request.body === null ? null : request.body.toString("utf8"),
      url: request.url.toString(),
    });
    if (request.method !== "POST") {
      return {
        status: 405,
        headers: { "content-type": "text/plain" } as Record<string, string>,
        body: (async function* (): AsyncIterable<Buffer> {
          yield Buffer.from("POST required");
        })(),
      };
    }
    let meshId: string;
    try {
      meshId = (JSON.parse(request.body?.toString("utf8") ?? "{}") as { mesh_id?: unknown }).mesh_id as string;
    } catch {
      return {
        status: 400,
        headers: { "content-type": "application/json" } as Record<string, string>,
        body: (async function* (): AsyncIterable<Buffer> {
          yield Buffer.from(JSON.stringify({ error: "invalid JSON body" }));
        })(),
      };
    }
    const payload = SPECIES_PAYLOAD(meshId);
    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      },
      body: (async function* (): AsyncIterable<Buffer> {
        yield Buffer.from(payload);
      })(),
    };
  };
}

/** A GET-only plan for the same POST endpoint (the pre-fix behavior). */
function getOnlyProvider(): AcquisitionProviderHandler {
  return {
    providerId: "gmrepo.get-only.v1",
    implementationDigest: GMREPO_FILES_IMPLEMENTATION_DIGEST,
    plan: (input) => ({
      source: {
        schema_version: "1.0",
        source_id: "source_gmrepo_get_only",
        database: "gmrepo",
        accession: input.parameters.accession as string,
        url: ENDPOINT,
        title: "GET-only probe",
        retrieved_at: new Date().toISOString(),
      },
      filename: "gmrepo_get_only.json",
      dataLevel: "repository_processed",
      maxBytes: 1024 * 1024,
      expectedMediaTypes: new Set(["application/json"]),
      accept: "application/json",
      allowedHosts: new Set([HOST]),
      assetRole: "carrier",
    }),
  };
}

describe("GMRepo POST-only acquisition", () => {
  it("reproduces no-data for a POST-only endpoint through the GET-only path", async () => {
    const requests: Array<{ method: string; body: string | null; url: string }> = [];
    const registry = new CoreAcquisitionRegistry();
    registry.registerProvider(getOnlyProvider());
    const fixture_ = await fixture({
      registry,
      executor: gmrepoExecutor(requests),
    });
    const raw = {
      ...request(MESH_HEALTH),
      request_id: "request_get_only",
      provider_id: "gmrepo.get-only.v1",
    };

    const failure = await fixture_.runtime.acquire(raw).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CoreAcquisitionError);
    expect(failure).toMatchObject({
      details: { provider_id: "gmrepo.get-only.v1", error_code: "network_error", attempts: 3 },
      retryable: false,
    });
    // Every attempt was a GET; the POST JSON body was never sent, so the
    // endpoint could never serve data and the fetch is recorded as no-data.
    expect(requests).toHaveLength(3);
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
    expect(requests.every((entry) => entry.body === null)).toBe(true);
  });

  it("acquires GMRepo species data through the trusted POST acquisition path", async () => {
    const requests: Array<{ method: string; body: string | null; url: string }> = [];
    const fixture_ = await fixture({ executor: gmrepoExecutor(requests) });

    const result = await fixture_.runtime.acquire(request(MESH_HEALTH));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", url: ENDPOINT });
    expect(JSON.parse(requests[0]!.body ?? "")).toEqual({ mesh_id: MESH_HEALTH });
    expect(result.sourceAsset).toEqual({
      schema_version: "1.0",
      asset_id: `asset_${createHash("sha256").update(SPECIES_PAYLOAD(MESH_HEALTH)).digest("hex")}`,
      task_id: "task_gmrepo",
      role: "carrier",
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ status: "succeeded", attempt_number: 1, retryable: false });

    const resolved = await fixture_.assets.resolveCoreAcquired(result.sourceAsset.asset_id, result.requestIdentityDigest);
    expect(resolved.acquisition_provenance).toMatchObject({
      provider_id: GMREPO_FILES_PROVIDER_ID,
      implementation_digest: GMREPO_FILES_IMPLEMENTATION_DIGEST,
      request_identity_digest: result.requestIdentityDigest,
      canonical_accession: MESH_HEALTH,
      provider_snapshot_identity: `${GMREPO_FILES_PROVIDER_ID}:official-api`,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of (await fixture_.assets.resolveAny(result.sourceAsset.asset_id)).content) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe(SPECIES_PAYLOAD(MESH_HEALTH));
  });

  it("keeps distinct POST bodies on the same endpoint in distinct cache entries", async () => {
    const requests: Array<{ method: string; body: string | null; url: string }> = [];
    const fixture_ = await fixture({ executor: gmrepoExecutor(requests) });

    const first = await fixture_.runtime.acquire(request(MESH_HEALTH));
    const second = await fixture_.runtime.acquire(request(MESH_UC));

    // A cache-key collision on the URL would serve the first body's bytes for
    // the second request; the variant key must force a second network call.
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1]!.body ?? "")).toEqual({ mesh_id: MESH_UC });
    expect(second.sourceAsset.asset_id).not.toBe(first.sourceAsset.asset_id);
    const secondBytes = await readFile(path.join(fixture_.root, "source_assets", second.sourceAsset.asset_id, `gmrepo_species_${MESH_UC}.json`), "utf8");
    expect(secondBytes).toBe(SPECIES_PAYLOAD(MESH_UC));
  });

  it("plans a fixed POST contract pinned to the official endpoint", async () => {
    const provider = createGmrepoFilesProvider();
    const plan = await provider.plan(request(MESH_HEALTH));

    expect(plan.source).toMatchObject({
      source_id: `source_gmrepo_${createHash("sha256").update(`${GMREPO_FILES_PROVIDER_ID}\u0000${MESH_HEALTH}`).digest("hex").slice(0, 20)}`,
      database: "gmrepo",
      accession: MESH_HEALTH,
      url: ENDPOINT,
    });
    expect(plan.method).toBe("POST");
    expect(JSON.parse(plan.body!)).toEqual({ mesh_id: MESH_HEALTH });
    expect(plan.filename).toBe(`gmrepo_species_${MESH_HEALTH}.json`);
    expect(plan.allowedHosts).toEqual(new Set([HOST]));
    expect(plan.expectedMediaTypes).toEqual(new Set(["application/json"]));
    expect(plan.assetRole).toBe("carrier");
    expect(plan.providerRevisionFacts).toEqual({
      canonical_accession: MESH_HEALTH,
      provider_snapshot_identity: `${GMREPO_FILES_PROVIDER_ID}:official-api`,
      provider_revision_token: null,
    });
  });

  it("rejects non-MeSH accessions and mismatched binding sources", async () => {
    const provider = createGmrepoFilesProvider();
    await expect(provider.plan(request("not-a-mesh"))).rejects.toThrow(/valid MeSH ID/);
    await expect(provider.plan(request("d006262"))).resolves.toMatchObject({
      method: "POST",
    });
    const wrongSource = request(MESH_HEALTH);
    wrongSource.parameters.source = "browser";
    await expect(provider.plan(wrongSource)).rejects.toThrow(/binding source 'gmrepo'/);
    const injected = request(MESH_HEALTH);
    injected.parameters.url = "https://evil.example/api";
    await expect(provider.plan(injected)).rejects.toThrow(/only source, accession, and entities/);
  });

  it("fails closed on invalid method/body plan combinations", async () => {
    const base = await createGmrepoFilesProvider().plan(request(MESH_HEALTH));
    const registry = new CoreAcquisitionRegistry();
    registry.registerProvider({
      providerId: "gmrepo.bad-plan.v1",
      implementationDigest: GMREPO_FILES_IMPLEMENTATION_DIGEST,
      plan: () => ({ ...base, body: undefined }),
    });
    const fixture_ = await fixture({
      registry,
      executor: gmrepoExecutor(),
    });
    await expect(fixture_.runtime.acquire({
      ...request(MESH_HEALTH),
      provider_id: "gmrepo.bad-plan.v1",
    })).rejects.toThrow(/requires a JSON request body/);
  });
});
