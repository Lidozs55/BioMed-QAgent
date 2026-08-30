import { deflateRawSync } from "node:zlib";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { crc32 } from "../../dataset/acquisition/zip-members.js";
import { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
import { createCoreAssetTools } from "./core-asset-tools.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function u16(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Buffer {
  return Buffer.from([value & 0xff, (value & 0xff00) >>> 8, (value & 0xff0000) >>> 16, (value >>> 24) & 0xff]);
}

function buildZip(entries: ReadonlyArray<{ name: string; data: Buffer; deflate: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localBytes = 0;
  for (const entry of entries) {
    const compressed = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const nameBytes = Buffer.from(entry.name, "utf8");
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(0), u32(compressed.byteLength), u32(entry.data.byteLength),
      u16(nameBytes.byteLength), u16(0), nameBytes, compressed,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0),
      u16(0), u32(crc32(entry.data)), u32(compressed.byteLength), u32(entry.data.byteLength),
      u16(nameBytes.byteLength), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(localBytes), nameBytes,
    ]));
    localBytes += local.byteLength;
  }
  const directory = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.byteLength), u32(localBytes), u16(0),
  ]);
  return Buffer.concat([...localParts, directory, eocd]);
}

async function createFixture(): Promise<{
  root: string;
  registry: SourceAssetRegistry;
  tools: ReturnType<typeof createCoreAssetTools>;
  zipAssetId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "core-asset-tools-"));
  cleanupRoots.push(root);
  const registry = new SourceAssetRegistry("task_fixture", root);
  await mkdir(path.join(root, "source_assets"), { recursive: true });
  const archive = buildZip([
    { name: "MOESM1.csv", data: Buffer.from("locus,pvalue\nrs1,1e-9\n", "utf8"), deflate: true },
    { name: "readme.txt", data: Buffer.from("supplementary notes", "utf8"), deflate: false },
  ]);
  await writeFile(path.join(root, "source_assets", "supplement.zip"), archive);
  const receipt = await registry.register({
    sourceId: "supplement_fixture",
    relativePath: "source_assets/supplement.zip",
    mediaType: "application/zip",
  });
  const tools = createCoreAssetTools({ sourceAssetRegistry: registry, sourceAssetsRoot: root });
  return { root, registry, tools, zipAssetId: receipt.asset_ref.asset_id };
}

describe("core asset preview/extract tools", () => {
  it("previews zip listings and member heads without executing anything", async () => {
    const { tools, zipAssetId } = await createFixture();
    const [preview] = tools;
    const listing = await preview.execute({ asset_id: zipAssetId });
    expect(listing.isError).not.toBe(true);
    const listingBody = JSON.parse(listing.content) as {
      is_zip: boolean;
      members: Array<{ name: string; uncompressedBytes: number }>;
    };
    expect(listingBody.is_zip).toBe(true);
    expect(listingBody.members.map((member) => member.name)).toEqual(["MOESM1.csv", "readme.txt"]);

    const head = await preview.execute({ asset_id: zipAssetId, member: "MOESM1.csv" });
    expect(head.isError).not.toBe(true);
    expect(JSON.parse(head.content)).toMatchObject({
      ok: true,
      member: "MOESM1.csv",
      head: "locus,pvalue\nrs1,1e-9\n",
    });
  });

  it("extracts a member into a new registered core asset bound by provenance name", async () => {
    const { registry, tools, zipAssetId } = await createFixture();
    const [, extract] = tools;
    const result = await extract.execute({ asset_id: zipAssetId, member: "MOESM1.csv" });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content) as {
      ok: boolean;
      asset_id: string;
      derived_from: string;
      relative_path: string;
    };
    expect(body.ok).toBe(true);
    expect(body.derived_from).toBe(zipAssetId);
    expect(body.asset_id).toMatch(/^asset_[0-9a-f]{64}$/);
    expect(body.relative_path.startsWith("source_assets/extract/")).toBe(true);

    const resolved = await registry.resolveAny(body.asset_id);
    expect(resolved.registration_receipt.media_type).toBe("text/csv");
  });

  it("registers extracted members with their true media types (case-insensitive, nested paths, extension-only)", async () => {
    const { root, registry, tools } = await createFixture();
    const typedArchive = buildZip([
      { name: "article.xml", data: Buffer.from("<?xml version='1.0'?><article/>", "utf8"), deflate: true },
      { name: "UPPER.XML", data: Buffer.from("<doc/>", "utf8"), deflate: false },
      { name: "nested/path/inner.xml", data: Buffer.from("<inner/>", "utf8"), deflate: false },
      { name: "table.tsv", data: Buffer.from("a\tb\n1\t2\n", "utf8"), deflate: false },
      { name: "meta.json", data: Buffer.from('{"ok":true}', "utf8"), deflate: false },
      { name: "paper.pdf", data: Buffer.from("%PDF-1.4\n", "utf8"), deflate: false },
      { name: "sheet.xlsx", data: Buffer.from("PK\u0003\u0004stub", "utf8"), deflate: false },
      // Misleading extension: content sniffing is out of scope; the extension
      // alone decides the media type.
      { name: "lies.xml", data: Buffer.from("locus,pvalue\nrs1,1e-9\n", "utf8"), deflate: false },
      { name: "noext", data: Buffer.from("\u0000\u0001\u0002opaque", "utf8"), deflate: false },
      { name: "unknown.xyz", data: Buffer.from("mystery", "utf8"), deflate: false },
    ]);
    await writeFile(path.join(root, "source_assets", "typed.zip"), typedArchive);
    const typedReceipt = await registry.register({
      sourceId: "typed_fixture",
      relativePath: "source_assets/typed.zip",
      mediaType: "application/zip",
    });
    const [, extract] = tools;
    const cases: ReadonlyArray<readonly [member: string, expectedMediaType: string]> = [
      ["article.xml", "application/xml"],
      ["UPPER.XML", "application/xml"],
      ["nested/path/inner.xml", "application/xml"],
      ["table.tsv", "text/tab-separated-values"],
      ["meta.json", "application/json"],
      ["paper.pdf", "application/pdf"],
      ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["lies.xml", "application/xml"],
      ["noext", "application/octet-stream"],
      ["unknown.xyz", "application/octet-stream"],
    ];
    const extractedIds = new Map<string, string>();
    for (const [member, expectedMediaType] of cases) {
      const result = await extract.execute({ asset_id: typedReceipt.asset_ref.asset_id, member });
      expect(result.isError, member).not.toBe(true);
      const body = JSON.parse(result.content) as { ok: boolean; asset_id: string; media_type: string };
      expect(body.ok, member).toBe(true);
      expect(body.media_type, member).toBe(expectedMediaType);
      extractedIds.set(member, body.asset_id);
    }
    // The receipt the registry recorded (what XML-expecting registered parsers
    // gate on) carries the corrected media type, not just the tool result body.
    const xmlAssetId = extractedIds.get("article.xml") ?? "";
    expect(xmlAssetId).toMatch(/^asset_[0-9a-f]{64}$/);
    const resolved = await registry.resolveAny(xmlAssetId);
    expect(resolved.registration_receipt.media_type).toBe("application/xml");
  });

  it("rejects unknown members and unsafe names with explicit errors", async () => {
    const { tools, zipAssetId } = await createFixture();
    const [preview, extract] = tools;
    const missing = await preview.execute({ asset_id: zipAssetId, member: "nope.csv" });
    expect(missing.isError).toBe(true);
    const unsafe = await extract.execute({ asset_id: zipAssetId, member: "../escape.csv" });
    expect(unsafe.isError).toBe(true);
  });
});
