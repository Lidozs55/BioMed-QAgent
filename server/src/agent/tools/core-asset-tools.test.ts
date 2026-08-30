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

  it("rejects unknown members and unsafe names with explicit errors", async () => {
    const { tools, zipAssetId } = await createFixture();
    const [preview, extract] = tools;
    const missing = await preview.execute({ asset_id: zipAssetId, member: "nope.csv" });
    expect(missing.isError).toBe(true);
    const unsafe = await extract.execute({ asset_id: zipAssetId, member: "../escape.csv" });
    expect(unsafe.isError).toBe(true);
  });
});
