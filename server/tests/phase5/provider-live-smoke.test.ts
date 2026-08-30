/**
 * Per-provider live smoke diagnostics (Gold10 acquisition blockers).
 *
 * Each provider is exercised INDEPENDENTLY — one binding, one runtime — so a
 * failing upstream (e.g. the 2026-08 GMRepo "数据获取异常" degradation) is
 * attributed immediately instead of surfacing as an aggregate error after a
 * full 30-binding build.
 *
 * Gated behind BIOMED_LIVE_SMOKE=1 exactly like live-smoke.test.ts: CI never
 * runs these (public services fail transiently); release verification runs
 * them and records date/endpoint/results.
 *
 * Happy-path providers assert a registered asset. The GMRepo block asserts
 * only the diagnostic contract (classified error code + per-binding details
 * on CoreAcquisitionError) because that upstream is known-unhealthy; its
 * output is the diagnostic value.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CoreAcquisitionError,
  CoreAcquisitionRegistry,
  CoreAcquisitionRuntime,
  type AcquisitionProviderHandler,
} from "../../src/dataset/acquisition/runtime.js";
import { createGmrepoFilesProvider } from "../../src/dataset/acquisition/gmrepo-provider.js";
import { createNcbiTaxonomyFilesProvider } from "../../src/dataset/acquisition/ncbi-taxonomy-provider.js";
import { ContentCache } from "../../src/external/acquisition/content-cache.js";
import { PublicHttpClient } from "../../src/external/network/http-client.js";
import { SourceAssetRegistry } from "../../src/runtime/source-assets/registry.js";

const ENABLED = process.env.BIOMED_LIVE_SMOKE === "1";
const describeLive = ENABLED ? describe : describe.skip;

function request(providerId: string, source: string, accession: string): CoreAcquisitionRequest {
  const idPart = providerId.replaceAll(".", "_");
  return {
    schema_version: "1.0",
    request_id: `request_smoke_${idPart}_${accession.replaceAll(/[^A-Za-z0-9_-]/g, "_")}`,
    task_id: "task_provider_smoke",
    requirement_id: "req_provider_smoke",
    binding_id: `binding_smoke_${idPart}`,
    mode: "builtin",
    provider_id: providerId,
    recipe_id: null,
    recipe_version: null,
    parameters: { source, accession, entities: {} },
  };
}

const roots: string[] = [];

async function runtime(providers: readonly AcquisitionProviderHandler[]): Promise<{
  root: string;
  runtime: CoreAcquisitionRuntime;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-smoke-"));
  roots.push(root);
  const registry = new CoreAcquisitionRegistry();
  for (const provider of providers) registry.registerProvider(provider);
  const assets = new SourceAssetRegistry("task_provider_smoke", root);
  return {
    root,
    runtime: new CoreAcquisitionRuntime({
      taskId: "task_provider_smoke",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({ timeoutMs: 60_000 }),
      sourceAssetRegistry: assets,
      registry,
      maxAttempts: 1,
    }),
  };
}

beforeAll(() => undefined);

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeLive("live:provider-smoke (Gold10 acquisition providers)", () => {
  it("MGnify study JSON registers as a carrier asset", async () => {
    const fixture = await runtime(
      (await import("../../src/dataset/acquisition/extended-providers.js")).createExtendedAcquisitionProviders()
        .filter((provider) => provider.providerId === "mgnify.files.v1"),
    );
    const result = await fixture.runtime.acquire(request("mgnify.files.v1", "mgnify", "MGYS00005647"));
    expect(result.sourceAsset.role).toBe("carrier");
    expect(result.attempts.at(-1)?.status).toBe("succeeded");
  });

  it("NCBI Taxonomy E-utilities esearch registers a small JSON carrier", async () => {
    const fixture = await runtime([createNcbiTaxonomyFilesProvider()]);
    const result = await fixture.runtime.acquire(request("ncbi.taxonomy.files.v1", "ncbi_taxonomy", "Blautia obeum"));
    expect(result.sourceAsset.role).toBe("carrier");
    expect(result.attempts.at(-1)?.status).toBe("succeeded");
  });

  it("Europe PMC search registers a JSON carrier through the curated path", async () => {
    const { acquireSource } = await import("../../src/external/acquisition/downloader.js");
    const root = await mkdtemp(path.join(os.tmpdir(), "epmc-smoke-"));
    roots.push(root);
    const result = await acquireSource({
      source: {
        schema_version: "1.0",
        source_id: "source_epmc_smoke",
        database: "pubmed",
        accession: "_search",
        url: "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=Blautia%20obeum&format=json&pageSize=1",
        title: "Europe PMC search smoke",
        retrieved_at: new Date().toISOString(),
      },
      filename: "epmc_search_smoke.json",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({ timeoutMs: 60_000 }),
      dataLevel: "repository_processed",
      maxBytes: 8 * 1024 * 1024,
      expectedMediaTypes: new Set(["application/json"]),
      accept: "application/json",
    });
    expect(result.attempt.status).toBe("succeeded");
    expect(result.asset).not.toBeNull();
  });

  it("GMRepo taxon phenotype summary classifies upstream failures with per-binding diagnostics", async () => {
    const fixture = await runtime([createGmrepoFilesProvider()]);
    const outcome = await fixture.runtime.acquire(request("gmrepo.files.v1", "gmrepo", "1234"))
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    if (outcome.ok) {
      expect(outcome.result.sourceAsset.role).toBe("carrier");
      return;
    }
    // The live endpoint is normally healthy; a failure is only acceptable when
    // it is fully attributed — classified error code plus binding/provider/
    // host/elapsed diagnostics on the CoreAcquisitionError.
    expect(outcome.error).toBeInstanceOf(CoreAcquisitionError);
    const failure = outcome.error as CoreAcquisitionError;
    expect(failure.details.error_code).toMatch(
      /^(?:network_error|dns_failure|tls_failure|connect_refused|connect_timeout|connection_reset|http_server_error|http_client_error|media_mismatch|size_exceeded|timeout|download_incomplete)$/,
    );
    expect(failure.details.provider_id).toBe("gmrepo.files.v1");
    expect(failure.details.binding_id).toBe("binding_smoke_gmrepo_files_v1");
    expect(failure.details.endpoint_host).toBe("gmrepo.humangut.info");
    expect(typeof failure.details.elapsed_ms).toBe("number");
    expect(failure.details.url).toContain("/api/getPhenotypesAndAbundanceSummaryOfAAssociatedTaxon/");
  });
});

describeLive("live:provider-smoke (supplementary xlsx extraction)", () => {
  it("Europe PMC supplementary archive stages members and parses XLSX worksheets to CSV", { timeout: 180_000 }, async () => {
    const fixture = await runtime(
      (await import("../../src/dataset/acquisition/extended-providers.js")).createExtendedAcquisitionProviders()
        .filter((provider) => provider.providerId === "europepmc.supplementary.v1"),
    );
    const result = await fixture.runtime.acquire(request("europepmc.supplementary.v1", "europepmc_supplementary", "PMC9005347"));
    expect(result.sourceAsset.role).toBe("carrier");
    expect(result.attempts.at(-1)?.status).toBe("succeeded");
    // Real Bellenguez 2022 archive: the XLSX member stages raw plus one
    // provenance-bound UTF-8 CSV per worksheet (Supplementary Table 5 is the
    // gold7 locus summary table).
    expect(result.extractionAssets.length).toBeGreaterThan(2);
    const registry = new SourceAssetRegistry("task_provider_smoke", fixture.root);
    const csvTexts: string[] = [];
    for (const asset of result.extractionAssets.slice(1)) {
      const chunks: Buffer[] = [];
      for await (const chunk of (await registry.resolveAny(asset.asset_id)).content) chunks.push(Buffer.from(chunk));
      csvTexts.push(Buffer.concat(chunks).toString("utf-8"));
    }
    expect(csvTexts.some((text) => text.includes("Supplementary Table"))).toBe(true);
  });
});

describeLive("live:provider-smoke (Europe PMC PDF carrier)", () => {
  it("registers the official full-text PDF with a %PDF- magic and intact receipt", { timeout: 180_000 }, async () => {
    const fixture = await runtime(
      (await import("../../src/dataset/acquisition/extended-providers.js")).createExtendedAcquisitionProviders()
        .filter((provider) => provider.providerId === "europepmc.pdf.v1"),
    );
    const result = await fixture.runtime.acquire(request("europepmc.pdf.v1", "europepmc_pdf", "PMC9005347"));
    expect(result.sourceAsset.role).toBe("carrier");
    expect(result.attempts.at(-1)?.status).toBe("succeeded");
    expect(result.sourceAsset.asset_id).toMatch(/^asset_[0-9a-f]{64}$/);

    // Receipt verification against the downloaded bytes; everything stays in
    // the task temp dir removed by afterAll — nothing is stored in git.
    const registry = new SourceAssetRegistry("task_provider_smoke", fixture.root);
    const resolved = await registry.resolveCarrier(result.sourceAsset.asset_id);
    const receipt = resolved.registration_receipt;
    expect(receipt.media_type).toBe("application/pdf");

    const chunks: Buffer[] = [];
    for await (const chunk of resolved.content) chunks.push(Buffer.from(chunk));
    const pdf = Buffer.concat(chunks);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBe(receipt.size_bytes);
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    expect(receipt.sha256).toBe(sha256);
    expect(result.sourceAsset.asset_id).toBe(`asset_${sha256}`);
  });
});
