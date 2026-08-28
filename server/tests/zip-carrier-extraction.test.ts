/**
 * ZIP carrier extraction tests: the deterministic stdlib ZIP reader plus the
 * CoreAcquisitionRuntime hook that stages provenance-bound member assets from
 * provider-declared `zipMemberExtraction` plans (Europe PMC supplementary
 * archives). The stored-entry fixture writer is intentionally tiny so the
 * byte layout stays auditable; the DEFLATE path is covered with real XLSX
 * buffers, which are themselves ZIP archives.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as XLSX from "xlsx";
import { afterEach, describe, expect, it } from "vitest";

import type { CoreAcquisitionRequest } from "@biomed/contracts";
import { CoreAcquisitionRegistry, CoreAcquisitionRuntime } from "../src/dataset/acquisition/runtime.js";
import { EXTENDED_PROVIDER_IDS } from "../src/dataset/acquisition/extended-providers.js";
import {
  crc32,
  extractZipMember,
  readZipCentralDirectory,
  selectExtractableZipMembers,
  ZipFormatError,
} from "../src/dataset/acquisition/zip-members.js";
import { xlsxWorksheetsToCsv } from "../src/dataset/acquisition/xlsx-to-csv.js";
import { ContentCache } from "../src/external/acquisition/content-cache.js";
import { PublicHttpClient, type RequestExecutor } from "../src/external/network/http-client.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const roots: string[] = [];

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

/** Build a STORE-method zip (no compression) with exact CRC-32 fields. */
function storedZip(files: Array<{ name: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf-8");
    const checksum = crc32(file.content);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(checksum), u32(file.content.length), u32(file.content.length),
      u16(nameBytes.length), u16(0), nameBytes, file.content,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(checksum), u32(file.content.length), u32(file.content.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameBytes,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...localParts, central, eocd]);
}

describe("zip member extraction", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("round-trips stored members through the central directory", () => {
    const archive = storedZip([
      { name: "TableS1.csv", content: Buffer.from("species,effect\nF. prausnitzii,-1.2\n") },
      { name: "notes.txt", content: Buffer.from("hello") },
    ]);
    const entries = readZipCentralDirectory(archive);
    expect(entries.map((entry) => entry.name)).toEqual(["TableS1.csv", "notes.txt"]);
    const selected = selectExtractableZipMembers(entries, {
      extensions: [".csv", ".tsv", ".xlsx"],
      maxMembers: 8,
      maxMemberBytes: 1024 * 1024,
    });
    expect(selected.map((entry) => entry.storedName)).toEqual(["TableS1.csv"]);
    const content = extractZipMember(archive, selected[0]!);
    expect(content.toString("utf-8")).toContain("F. prausnitzii");
  });

  it("reads DEFLATE members from real XLSX buffers", () => {
    const sheet = XLSX.utils.aoa_to_sheet([["a"], [1]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "S");
    const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    const entries = readZipCentralDirectory(buffer);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const content = extractZipMember(buffer, entry);
      expect(content.length).toBe(entry.uncompressedSize);
      expect(crc32(content)).toBe(entry.crc32);
    }
  });

  it("rejects traversal names and corrupt CRCs instead of staging them", () => {
    const entries = [
      { name: "../escape.csv", method: 0, crc32: 0, compressedSize: 2, uncompressedSize: 2, localHeaderOffset: 0 },
    ] as const;
    const selected = selectExtractableZipMembers(entries as never, {
      extensions: [".csv"],
      maxMembers: 8,
      maxMemberBytes: 1024,
    });
    expect(selected).toEqual([]);

    const archive = storedZip([{ name: "bad.csv", content: Buffer.from("x") }]);
    const entry = readZipCentralDirectory(archive)[0]!;
    const corrupted = { ...entry, crc32: entry.crc32 ^ 0xffff };
    expect(() => extractZipMember(archive, corrupted)).toThrow(ZipFormatError);
    expect(() => extractZipMember(archive, { ...entry, method: 99 })).toThrow(ZipFormatError);
  });

  it("stages provenance-bound member assets from a Europe PMC supplementary archive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "epmc-zip-"));
    roots.push(root);
    const csv = Buffer.from("taxon,effect_direction\nFusobacterium nucleatum,increase\n");
    const xlsx = Buffer.from(XLSX.write((() => {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["taxon"], ["P. micra"]]), "S1");
      return workbook;
    })(), { type: "buffer", bookType: "xlsx" }));
    const archive = storedZip([
      { name: "S1_differential.csv", content: csv },
      { name: "S2_counts.xlsx", content: xlsx },
      { name: "figure1.png", content: Buffer.from([0x89, 0x50]) },
    ]);
    const requests: Array<{ url: string; body: string | null }> = [];
    const executor: RequestExecutor = async (request) => {
      requests.push({ url: request.url.toString(), body: request.body?.toString("utf8") ?? null });
      return {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": String(archive.length) },
        body: (async function* (): AsyncIterable<Buffer> { yield archive; })(),
      };
    };
    const client = new PublicHttpClient({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      executor,
    });
    const registry = new CoreAcquisitionRegistry();
    const providers = (await import("../src/dataset/acquisition/extended-providers.js"))
      .createExtendedAcquisitionProviders();
    const provider = providers.find((entry) => entry.providerId === EXTENDED_PROVIDER_IDS.europePmcSupplementary);
    expect(provider).toBeDefined();
    registry.registerProvider(provider!);
    const assets = new SourceAssetRegistry("task_epmc_zip", root, { now: () => new Date("2026-08-27T00:00:00.000Z") });
    const runtime = new CoreAcquisitionRuntime({
      taskId: "task_epmc_zip",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client,
      sourceAssetRegistry: assets,
      registry,
      maxAttempts: 2,
    });
    const request: CoreAcquisitionRequest = {
      schema_version: "1.0",
      request_id: "request_epmc_zip",
      task_id: "task_epmc_zip",
      requirement_id: "build_epmc_zip",
      binding_id: "binding_epmc",
      mode: "builtin",
      provider_id: EXTENDED_PROVIDER_IDS.europePmcSupplementary,
      recipe_id: null,
      recipe_version: null,
      parameters: { source: "europepmc_supplementary", accession: "PMC9005347", entities: {} },
    };

    const result = await runtime.acquire(request);

    expect(requests[0]!.url).toContain("/PMC9005347/supplementaryFiles");
    expect(result.sourceAsset.role).toBe("carrier");
    // csv member, raw xlsx member, plus the parsed per-worksheet CSV of S2_counts.xlsx
    expect(result.extractionAssets).toHaveLength(3);
    for (const ref of result.extractionAssets) expect(ref.role).toBe("carrier");
    expect(result.extractionAssets[0]!.asset_id).toBe(`asset_${createHash("sha256").update(csv).digest("hex")}`);
    expect(result.extractionAssets[1]!.asset_id).toBe(`asset_${createHash("sha256").update(xlsx).digest("hex")}`);
    const parsedCsvId = result.extractionAssets[2]!.asset_id;
    const parsedBytes: Buffer[] = [];
    for await (const chunk of (await assets.resolveAny(parsedCsvId)).content) parsedBytes.push(Buffer.from(chunk));
    expect(Buffer.concat(parsedBytes).toString("utf-8")).toContain("P. micra");
    const resolved = await assets.resolveAny(result.extractionAssets[0]!.asset_id);
    const chunks: Buffer[] = [];
    for await (const chunk of resolved.content) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf-8")).toContain("Fusobacterium nucleatum");
    const provenance = await assets.resolveCoreAcquired(
      result.extractionAssets[0]!.asset_id,
      result.requestIdentityDigest,
    );
    expect(provenance.acquisition_provenance).toMatchObject({
      provider_id: "europepmc.supplementary.v1",
      canonical_accession: "PMC9005347",
    });
    const parsedProvenance = await assets.resolveCoreAcquired(
      parsedCsvId,
      result.requestIdentityDigest,
    );
    expect(parsedProvenance.acquisition_provenance).toMatchObject({
      provider_id: "europepmc.supplementary.v1",
      canonical_accession: "PMC9005347",
    });
    expect(parsedProvenance.registration_receipt.relative_path).toContain("_p0.csv");
  });

  it("parses every bounded worksheet of an XLSX member into UTF-8 CSV extraction assets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "epmc-xlsx-"));
    roots.push(root);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["locus", "odds_ratio"], ["rs123456", 1.25]]),
      "Loci",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["gene", "chr"], ["APOE", 19]]),
      "Genes",
    );
    const xlsx = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    const archive = storedZip([{ name: "bellenguez_tables.xlsx", content: xlsx }]);
    const executor: RequestExecutor = async () => ({
      status: 200,
      headers: { "content-type": "application/zip", "content-length": String(archive.length) },
      body: (async function* (): AsyncIterable<Buffer> { yield archive; })(),
    });
    const client = new PublicHttpClient({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      executor,
    });
    const registry = new CoreAcquisitionRegistry();
    const providers = (await import("../src/dataset/acquisition/extended-providers.js"))
      .createExtendedAcquisitionProviders();
    registry.registerProvider(providers.find(
      (entry) => entry.providerId === EXTENDED_PROVIDER_IDS.europePmcSupplementary,
    )!);
    const assets = new SourceAssetRegistry("task_epmc_xlsx", root, { now: () => new Date("2026-08-27T00:00:00.000Z") });
    const runtime = new CoreAcquisitionRuntime({
      taskId: "task_epmc_xlsx",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client,
      sourceAssetRegistry: assets,
      registry,
      maxAttempts: 2,
    });
    const request: CoreAcquisitionRequest = {
      schema_version: "1.0",
      request_id: "request_epmc_xlsx",
      task_id: "task_epmc_xlsx",
      requirement_id: "build_epmc_xlsx",
      binding_id: "binding_epmc",
      mode: "builtin",
      provider_id: EXTENDED_PROVIDER_IDS.europePmcSupplementary,
      recipe_id: null,
      recipe_version: null,
      parameters: { source: "europepmc_supplementary", accession: "PMC9005347", entities: {} },
    };

    const result = await runtime.acquire(request);

    // raw xlsx member plus one parsed CSV per worksheet, in workbook order
    expect(result.extractionAssets).toHaveLength(3);
    const sheet0 = await readAll(assets, result.extractionAssets[1]!.asset_id);
    const sheet1 = await readAll(assets, result.extractionAssets[2]!.asset_id);
    expect(sheet0).toContain("rs123456");
    expect(sheet0).toContain("odds_ratio");
    expect(sheet1).toContain("APOE");
  });

  it("keeps a corrupt XLSX member staged without parsed assets and without failing acquisition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "epmc-xlsx-bad-"));
    roots.push(root);
    const archive = storedZip([{ name: "broken.xlsx", content: Buffer.from("this is not a workbook") }]);
    const executor: RequestExecutor = async () => ({
      status: 200,
      headers: { "content-type": "application/zip", "content-length": String(archive.length) },
      body: (async function* (): AsyncIterable<Buffer> { yield archive; })(),
    });
    const client = new PublicHttpClient({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      executor,
    });
    const registry = new CoreAcquisitionRegistry();
    const providers = (await import("../src/dataset/acquisition/extended-providers.js"))
      .createExtendedAcquisitionProviders();
    registry.registerProvider(providers.find(
      (entry) => entry.providerId === EXTENDED_PROVIDER_IDS.europePmcSupplementary,
    )!);
    const assets = new SourceAssetRegistry("task_epmc_bad", root, { now: () => new Date("2026-08-27T00:00:00.000Z") });
    const runtime = new CoreAcquisitionRuntime({
      taskId: "task_epmc_bad",
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client,
      sourceAssetRegistry: assets,
      registry,
      maxAttempts: 2,
    });
    const request: CoreAcquisitionRequest = {
      schema_version: "1.0",
      request_id: "request_epmc_bad",
      task_id: "task_epmc_bad",
      requirement_id: "build_epmc_bad",
      binding_id: "binding_epmc",
      mode: "builtin",
      provider_id: EXTENDED_PROVIDER_IDS.europePmcSupplementary,
      recipe_id: null,
      recipe_version: null,
      parameters: { source: "europepmc_supplementary", accession: "PMC9005347", entities: {} },
    };

    const result = await runtime.acquire(request);

    const memberBytes = Buffer.from("this is not a workbook");
    expect(result.extractionAssets).toHaveLength(1);
    expect(result.extractionAssets[0]!.asset_id).toBe(`asset_${createHash("sha256").update(memberBytes).digest("hex")}`);
  });
});

async function readAll(assets: SourceAssetRegistry, assetId: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of (await assets.resolveAny(assetId)).content) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

describe("xlsx worksheet to CSV conversion", () => {
  function workbookWithSheets(sheets: Array<{ name: string; rows: unknown[][] }>): Buffer {
    const workbook = XLSX.utils.book_new();
    for (const sheet of sheets) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
    }
    return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  }

  it("emits every worksheet as UTF-8 CSV in workbook order", () => {
    const parsed = xlsxWorksheetsToCsv(
      workbookWithSheets([
        { name: "Loci", rows: [["locus", "p_value"], ["rs1", 5e-8]] },
        { name: "Genes", rows: [["gene"], ["APOE"]] },
      ]),
      { maxWorksheets: 8, maxCsvBytes: 1024 * 1024 },
    );
    expect(parsed.map((sheet) => sheet.sheetName)).toEqual(["Loci", "Genes"]);
    expect(parsed[0]!.csv.toString("utf-8")).toContain("rs1");
    expect(parsed[1]!.csv.toString("utf-8")).toContain("APOE");
  });

  it("keeps only the first bounded worksheets and skips oversized sheets", () => {
    const many = xlsxWorksheetsToCsv(
      workbookWithSheets([
        { name: "S1", rows: [["a"], [1]] },
        { name: "S2", rows: [["b"], [2]] },
        { name: "S3", rows: [["c"], [3]] },
      ]),
      { maxWorksheets: 2, maxCsvBytes: 1024 * 1024 },
    );
    expect(many.map((sheet) => sheet.sheetName)).toEqual(["S1", "S2"]);

    const oversized = xlsxWorksheetsToCsv(
      workbookWithSheets([{ name: "Big", rows: [["value"], ["x".repeat(4096)]] }]),
      { maxWorksheets: 2, maxCsvBytes: 64 },
    );
    expect(oversized).toEqual([]);
  });

  it("returns no sheets for unreadable workbooks", () => {
    expect(xlsxWorksheetsToCsv(Buffer.from("not a workbook"), { maxWorksheets: 2, maxCsvBytes: 1024 })).toEqual([]);
  });
});

describe("extraction member resolution", () => {
  it("resolves registered relative paths outside the legacy asset-id layout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gmrepo-"));
    roots.push(root);
    const registry = new SourceAssetRegistry("task_layout", root);
    const { writeFile, mkdir } = await import("node:fs/promises");
    const relativePath = "source_assets/extracted/digest123/0_TableS1.csv";
    await mkdir(path.join(root, "source_assets", "extracted", "digest123"), { recursive: true });
    await writeFile(path.join(root, ...relativePath.split("/")), "taxon,count\nA,1\n");
    const receipt = await registry.register({
      sourceId: "source_extracted_member",
      relativePath,
      role: "carrier",
      mediaType: "text/csv",
    });
    expect(await registry.registeredRelativePath(receipt.asset_ref.asset_id)).toBe(relativePath);
    expect(await registry.registeredRelativePath("asset_unknown")).toBeNull();
  });
});
