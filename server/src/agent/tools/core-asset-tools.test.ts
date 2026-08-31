import { deflateRawSync, gzipSync } from "node:zlib";
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
  await registry.registerCoreAcquisitionProvenance(receipt, {
    provider_id: "fixture.provider",
    implementation_digest: "a".repeat(64),
    request_identity_digest: "b".repeat(64),
    canonical_accession: "supplement.zip",
  });
  const tools = createCoreAssetTools({ taskId: "task_fixture", sourceAssetRegistry: registry, sourceAssetsRoot: root });
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
    const closure = await registry.resolveFormalProvenanceClosure(body.asset_id);
    expect(closure).toHaveLength(2);
    const derived = closure.find((item) => "operation_kind" in item);
    expect(derived).toMatchObject({
      operation_kind: "archive_member_extraction",
      parent_asset_ids: [zipAssetId],
    });
    const operationResult = await registry.resolveDerivedOperationResult(
      (derived as { operation_result_id: string }).operation_result_id,
    );
    expect(operationResult.commit.state).toBe("committed");
    expect(operationResult.output_files).toEqual([expect.objectContaining({
      relative_path: resolved.registration_receipt.relative_path,
      sha256: resolved.registration_receipt.sha256,
      size_bytes: resolved.registration_receipt.size_bytes,
    })]);  });

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
    await registry.registerCoreAcquisitionProvenance(typedReceipt, {
      provider_id: "fixture.provider",
      implementation_digest: "a".repeat(64),
      request_identity_digest: "d".repeat(64),
      canonical_accession: "typed.zip",
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

  it("previews a gzip asset as decoded text and extracts it with its true media type", async () => {
    const { root, registry, tools } = await createFixture();
    const gz = gzipSync(Buffer.from("record_id,value\nr1,1\nr2,2\n", "utf8"));
    await writeFile(path.join(root, "source_assets", "GPL96.annot.csv.gz"), gz);
    const receipt = await registry.register({
      sourceId: "gzip_fixture",
      relativePath: "source_assets/GPL96.annot.csv.gz",
      mediaType: "application/gzip",
    });
    await registry.registerCoreAcquisitionProvenance(receipt, {
      provider_id: "fixture.provider",
      implementation_digest: "a".repeat(64),
      request_identity_digest: "c".repeat(64),
      canonical_accession: "GPL96.annot.csv.gz",
    });
    const [preview, extract] = tools;

    // Preview decodes the stream instead of surfacing gzip binary (the
    // gold1/gold4 failure shape: ".gz preview returns binary").
    const head = await preview.execute({ asset_id: receipt.asset_ref.asset_id });
    expect(head.isError).not.toBe(true);
    const headBody = JSON.parse(head.content) as {
      ok: boolean;
      is_gzip: boolean;
      decoded_size_bytes: number;
      media_type: string;
      head: string;
    };
    expect(headBody.ok).toBe(true);
    expect(headBody.is_gzip).toBe(true);
    expect(headBody.decoded_size_bytes).toBe(26);
    expect(headBody.media_type).toBe("text/csv");
    expect(headBody.head).toBe("record_id,value\nr1,1\nr2,2\n");

    // Extract decodes the whole stream into a text/csv registered asset.
    const extracted = await extract.execute({ asset_id: receipt.asset_ref.asset_id });
    expect(extracted.isError).not.toBe(true);
    const body = JSON.parse(extracted.content) as { ok: boolean; asset_id: string; media_type: string; member: string | null };
    expect(body.ok).toBe(true);
    expect(body.member).toBeNull();
    expect(body.media_type).toBe("text/csv");
    expect(body.asset_id).toMatch(/^asset_[0-9a-f]{64}$/);
    const resolved = await registry.resolveAny(body.asset_id);
    expect(resolved.registration_receipt.media_type).toBe("text/csv");
    expect(resolved.registration_receipt.relative_path).toMatch(/\/extract\/[^/]+\/[^/]+\.csv$/);

    // A non-gzip file simply previews as its plain text (no magic bytes); a
    // file whose extension claims gzip but is neither zip nor gzip fails
    // closed on extraction instead of surfacing raw bytes or hanging.
    await writeFile(path.join(root, "source_assets", "broken.csv.gz"), Buffer.from("not gzip bytes"));
    const brokenReceipt = await registry.register({
      sourceId: "broken_fixture",
      relativePath: "source_assets/broken.csv.gz",
      mediaType: "application/gzip",
    });
    const brokenHead = await preview.execute({ asset_id: brokenReceipt.asset_ref.asset_id });
    expect(brokenHead.isError).not.toBe(true);
    const brokenHeadBody = JSON.parse(brokenHead.content) as { ok: boolean; is_gzip?: boolean; head: string };
    expect(brokenHeadBody.ok).toBe(true);
    expect(brokenHeadBody.is_gzip).toBeUndefined();
    expect(brokenHeadBody.head).toContain("not gzip bytes");
    const brokenExtract = await extract.execute({ asset_id: brokenReceipt.asset_ref.asset_id });
    expect(brokenExtract.isError).toBe(true);
    expect(JSON.parse(brokenExtract.content)).toMatchObject({
      ok: false,
      error: { code: "core_archive_extract_rejected" },
    });
  });
});
