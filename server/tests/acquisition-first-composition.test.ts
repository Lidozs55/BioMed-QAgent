import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHEMBL_FILES_PROVIDER_ID,
  CHEMBL_FILES_SOURCE_ID_PREFIX,
  chemblFilesUrl,
  createChemblFilesProvider,
} from "../src/dataset/acquisition/chembl-provider.js";
import type { CoreAcquisitionError } from "../src/dataset/acquisition/runtime.js";
import { FIXED_BIOMEDICAL_PROVIDER_IDS } from "../src/dataset/acquisition/biomedical-providers.js";
import {
  createGeoFilesProvider,
  GEO_FILES_PROVIDER_ID,
} from "../src/dataset/acquisition/expression-providers.js";
import { ContentCache } from "../src/external/acquisition/content-cache.js";
import { PublicHttpClient } from "../src/external/network/http-client.js";
import { createPhase3AcquisitionRuntime } from "../src/runtime/phase3-composition.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const roots: string[] = [];
const CONTENT = JSON.stringify({ activities: [], page_meta: { total_count: 0 } });

const CHEMBL_PARAMETERS: CoreAcquisitionRequest["parameters"] = {
  source: "chembl",
  accession: "CHEMBL9999",
  entities: {
    chembl_compounds: ["CHEMBL200", "CHEMBL100"],
    activity_types: ["Ki", "IC50"],
  },
};

function request(
  parameters: CoreAcquisitionRequest["parameters"] = CHEMBL_PARAMETERS,
  taskId = "task_chembl",
): CoreAcquisitionRequest {
  return {
    schema_version: "1.0",
    request_id: "request_chembl",
    task_id: taskId,
    requirement_id: "build_chembl",
    binding_id: "binding_chembl",
    mode: "builtin",
    provider_id: CHEMBL_FILES_PROVIDER_ID,
    recipe_id: null,
    recipe_version: null,
    parameters,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("acquisition-first phase3 composition", () => {
  it.each([
    ["GSE1", "GSEnnn"],
    ["GSE99", "GSEnnn"],
    ["GSE100", "GSEnnn"],
  ])("uses the NCBI GEO GSEnnn group for %s", (accession, group) => {
    const plan = createGeoFilesProvider().plan({
      ...request(),
      provider_id: GEO_FILES_PROVIDER_ID,
      parameters: { source: "geo", accession, entities: {} },
    });
    expect(plan).toMatchObject({
      source: {
        url: `https://ftp.ncbi.nlm.nih.gov/geo/series/${group}/${accession}/matrix/${accession}_series_matrix.txt.gz`,
      },
    });
  });

  it.each([
    ["geo", "geo.files.v1", "GSE178352", "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/matrix/GSE178352_series_matrix.txt.gz"],
    ["gdc", "gdc.files.v1", "FILE-123", "https://api.gdc.cancer.gov/data/FILE-123"],
  ])("registers the production %s expression provider with trusted revision facts", async (source, providerId, accession, expectedUrl) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `acquisition-first-${source}-`));
    roots.push(root);
    const bytes = Buffer.from("gene_id\tS1\nTP53\t1\n");
    const executor = vi.fn(async ({ url }: { url: URL }) => {
      expect(url.toString()).toBe(expectedUrl);
      return {
        status: 200,
        headers: {
          "content-type": "text/tab-separated-values",
          "content-length": String(bytes.length),
        },
        body: (async function* (): AsyncIterable<Buffer> { yield bytes; })(),
      };
    });
    const registry = new SourceAssetRegistry(source === "geo" ? "task_geo" : "task_gdc", root);
    const runtime = createPhase3AcquisitionRuntime({
      taskId: source === "geo" ? "task_geo" : "task_gdc",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        executor,
      }),
      sourceAssetRegistry: registry,
    });

    const result = await runtime.acquire({
      ...request(),
      request_id: `request_${source}`,
      task_id: source === "geo" ? "task_geo" : "task_gdc",
      binding_id: `binding_${source}`,
      provider_id: providerId,
      parameters: { source, accession, entities: {} },
    });

    expect(result.providerRevisionEvidence).toMatchObject([{
      canonical_accession: accession,
      provider_snapshot_identity: expect.stringContaining(`${source}:`),
      source_asset_registration_receipt: { asset_ref: { role: "carrier" } },
    }]);
    await expect(registry.resolveCoreAcquired(result.sourceAsset.asset_id)).resolves.toMatchObject({
      acquisition_provenance: {
        canonical_accession: accession,
        provider_snapshot_identity: expect.stringContaining(`${source}:`),
      },
    });
  });

  it("caps ChEMBL activity requests with declared pagination so results are never silently truncated", async () => {
    const url = new URL(chemblFilesUrl({
      targetId: "CHEMBL9999",
      compoundIds: ["CHEMBL100", "CHEMBL200"],
      activityTypes: ["IC50", "Ki"],
    }));
    expect(url.searchParams.get("limit")).toBe("1000");
    expect(url.searchParams.get("offset")).toBe("0");
    const plan = await createChemblFilesProvider().plan(request());
    expect(plan.maxBytes).toBe(64 * 1024 * 1024);
    expect(plan.pagination).toEqual({
      recordsPath: "activities",
      pageSize: 1000,
      maxRecords: 10000,
      maxPages: 10,
    });
  });

  it("registers the fixed ChEMBL provider and publishes a carrier asset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acquisition-first-"));
    roots.push(root);
    const executor = vi.fn(async ({ url }: { url: URL }) => {
      expect(url.toString()).toBe(chemblFilesUrl({
        targetId: "CHEMBL9999",
        compoundIds: ["CHEMBL100", "CHEMBL200"],
        activityTypes: ["IC50", "Ki"],
      }));
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(CONTENT)),
        },
        body: (async function* (): AsyncIterable<Buffer> {
          yield Buffer.from(CONTENT);
        })(),
      };
    });
    const client = new PublicHttpClient({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      executor,
    });
    const runtime = createPhase3AcquisitionRuntime({
      taskId: "task_chembl",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client,
    });

    const result = await runtime.acquire(request());

    expect(result.sourceAsset).toMatchObject({
      task_id: "task_chembl",
      role: "carrier",
    });
    const plan = await createChemblFilesProvider().plan(request());
    expect(plan.source.source_id).toMatch(new RegExp(`^${CHEMBL_FILES_SOURCE_ID_PREFIX}_[0-9a-f]{20}$`));
    expect(result.attempts).toHaveLength(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("merges ChEMBL pages into one asset and requests each offset until a short page", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acquisition-first-"));
    roots.push(root);
    const pageBody = (offset: number, count: number, total: number): string =>
      JSON.stringify({
        activities: Array.from({ length: count }, (_, i) => ({ activity_id: offset + i })),
        page_meta: { limit: 1000, offset, total_count: total },
      });
    const requestedUrls: string[] = [];
    const executor = vi.fn(async ({ url }: { url: URL }) => {
      requestedUrls.push(url.toString());
      const offset = Number(url.searchParams.get("offset"));
      const count = offset === 0 ? 1000 : 700;
      const body = pageBody(offset, count, 1700);
      return {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        body: (async function* (): AsyncIterable<Buffer> {
          yield Buffer.from(body);
        })(),
      };
    });
    const client = new PublicHttpClient({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      executor,
    });
    const runtime = createPhase3AcquisitionRuntime({
      taskId: "task_chembl_pages",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client,
    });

    const result = await runtime.acquire(request(CHEMBL_PARAMETERS, "task_chembl_pages"));
    expect(result.attempts).toHaveLength(1);
    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[0]!).searchParams.get("offset")).toBe("0");
    expect(new URL(requestedUrls[1]!).searchParams.get("offset")).toBe("1000");
    const expected = JSON.stringify({
      activities: Array.from({ length: 1700 }, (_, i) => ({ activity_id: i })),
      page_meta: { limit: 1000, offset: 1000, total_count: 1700 },
    });
    const sha = createHash("sha256").update(expected).digest("hex");
    const merged = JSON.parse(await readFile(
      path.join(root, "source_assets", `asset_${sha}`, "chembl-chembl9999-bioactivity.json"),
      "utf8",
    ));
    expect(merged.activities).toHaveLength(1700);
    expect(merged.activities[0].activity_id).toBe(0);
    expect(merged.activities[1699].activity_id).toBe(1699);
    expect(merged.page_meta).toEqual({ limit: 1000, offset: 1000, total_count: 1700 });
  });

  it("fails loudly when ChEMBL pagination exhausts its configured record cap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acquisition-first-"));
    roots.push(root);
    const executor = vi.fn(async ({ url }: { url: URL }) => {
      const offset = Number(url.searchParams.get("offset"));
      const body = JSON.stringify({
        activities: Array.from({ length: 1000 }, (_, i) => ({ activity_id: offset + i })),
        page_meta: { limit: 1000, offset, total_count: 999_999 },
      });
      return {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        body: (async function* (): AsyncIterable<Buffer> {
          yield Buffer.from(body);
        })(),
      };
    });
    const client = new PublicHttpClient({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      executor,
    });
    const runtime = createPhase3AcquisitionRuntime({
      taskId: "task_chembl_cap",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client,
      chemblMaxRecords: 2000,
    });

    const error = await runtime.acquire(request(CHEMBL_PARAMETERS, "task_chembl_cap")).then(
      (): CoreAcquisitionError => { throw new Error("expected paginated acquisition to fail"); },
      (reason: unknown) => reason as CoreAcquisitionError,
    );
    expect(error.message).toBe("acquisition failed: validation_error");
    expect(error.details.error_message).toContain("pagination_record_cap_exceeded");
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("rejects unregistered ChEMBL query controls and incomplete identities", async () => {
    const provider = createChemblFilesProvider();
    const invalidParameters: CoreAcquisitionRequest["parameters"][] = [
      { ...CHEMBL_PARAMETERS, url: "https://evil.example" },
      { ...CHEMBL_PARAMETERS, source: "browser" },
      { ...CHEMBL_PARAMETERS, accession: null },
      { ...CHEMBL_PARAMETERS, entities: { chembl_compounds: [] } },
      { ...CHEMBL_PARAMETERS, entities: { chembl_compounds: ["CHEMBL100"], activity_types: ["arbitrary"] } },
    ];
    for (const parameters of invalidParameters) {
      expect(() => provider.plan(request(parameters))).toThrow();
    }
  });

  it("registers PDB and acquires a server-derived RCSB carrier plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acquisition-first-"));
    roots.push(root);
    const executor = vi.fn(async ({ url }: { url: URL }) => {
      expect(url.toString()).toBe("https://files.rcsb.org/download/6M0J.pdb");
      return {
        status: 200,
        headers: { "content-type": "chemical/x-pdb", "content-length": "7" },
        body: (async function* (): AsyncIterable<Buffer> { yield Buffer.from("HEADER\n"); })(),
      };
    });
    const runtime = createPhase3AcquisitionRuntime({
      taskId: "task_chembl",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        executor,
      }),
    });

    const result = await runtime.acquire({
      ...request(),
      request_id: "request_pdb",
      binding_id: "binding_pdb",
      provider_id: FIXED_BIOMEDICAL_PROVIDER_IDS.pdb,
      parameters: { source: "pdb", accession: null, entities: { pdb_ids: ["6m0j"] } },
    });

    expect(result.sourceAsset).toMatchObject({ task_id: "task_chembl", role: "carrier" });
    expect(result.attempts[0]).toMatchObject({ provider_id: "pdb.files.v1", status: "succeeded" });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("rejects Agent-controlled ChEMBL parameters before network access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acquisition-first-"));
    roots.push(root);
    const executor = vi.fn(async () => {
      throw new Error("must not execute");
    });
    const runtime = createPhase3AcquisitionRuntime({
      taskId: "task_chembl",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        executor,
      }),
    });

    await expect(runtime.acquire(request({ limit: 500 }))).rejects.toThrow(
      /only server-owned source, accession, and entities/,
    );
    expect(executor).not.toHaveBeenCalled();
  });
});
