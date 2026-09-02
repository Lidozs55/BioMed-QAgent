/**
 * M2 (gold2-r2 2026-08-31) — preview_core_asset must page text, not just head
 * it. A fixed 8192-character head window left the middle of a 153 MB SOFT
 * carrier unreachable (the needed ``!Sample_characteristics`` field sits far
 * past the head), and the model chose to answer without the field rather than
 * fabricate it. This suite pins workspace_read-style offset/length character
 * paging across the three text surfaces (plain asset, gzip member, zip
 * member), the per-call ceiling, and that the member listing stays
 * listing-only.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { crc32 } from "../src/dataset/acquisition/zip-members.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { createPreviewCoreAssetTool } from "../src/agent/tools/core-asset-tools.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function u16(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Buffer {
  return Buffer.from([value & 0xff, (value & 0xff00) >>> 8, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

/** Build a STORE-method zip; the preview tool CRC-verifies each member. */
function storedZip(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localBytes = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc32(entry.data)), u32(entry.data.byteLength), u32(entry.data.byteLength),
      u16(nameBytes.byteLength), u16(0), nameBytes, entry.data,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc32(entry.data)), u32(entry.data.byteLength), u32(entry.data.byteLength),
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

interface Fixture {
  root: string;
  preview: ReturnType<typeof createPreviewCoreAssetTool>;
  registerTextAsset: (name: string, data: Buffer) => Promise<string>;
}

async function createFixture(taskId: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "preview-paging-"));
  cleanupRoots.push(root);
  await mkdir(path.join(root, "source_assets"), { recursive: true });
  const registry = new SourceAssetRegistry(taskId, root);
  const preview = createPreviewCoreAssetTool({
    taskId,
    sourceAssetRegistry: registry,
    sourceAssetsRoot: root,
  });
  const registerTextAsset = async (name: string, data: Buffer): Promise<string> => {
    await writeFile(path.join(root, "source_assets", name), data);
    const receipt = await registry.register({
      sourceId: `fixture_${name.replaceAll(/[^A-Za-z0-9_-]/g, "_")}`,
      relativePath: `source_assets/${name}`,
      role: "source",
      mediaType: "text/plain",
    });
    return receipt.asset_ref.asset_id;
  };
  return { root, preview, registerTextAsset };
}

interface PreviewPayload {
  ok: boolean;
  head?: string;
  offset?: number;
  characters?: number;
  truncated?: boolean;
  error?: { message: string };
}

async function readPage(
  preview: Fixture["preview"],
  args: Record<string, unknown>,
): Promise<PreviewPayload> {
  const result = await preview.execute(args);
  return JSON.parse(result.content) as PreviewPayload;
}

describe("preview_core_asset text paging (M2)", () => {
  it("defaults to the 8192-character head and marks remaining text", async () => {
    const { preview, registerTextAsset } = await createFixture("task_paging_head");
    const assetId = await registerTextAsset("soft.txt", Buffer.from("a".repeat(10_000), "utf8"));
    const page = await readPage(preview, { asset_id: assetId });
    expect(page.ok).toBe(true);
    expect(page.head).toHaveLength(8192);
    expect(page.offset).toBe(0);
    expect(page.characters).toBe(8192);
    expect(page.truncated).toBe(true);
  });

  it("reaches the middle and the exact tail of a large text asset", async () => {
    const { preview, registerTextAsset } = await createFixture("task_paging_middle");
    const lines = Array.from({ length: 10_000 }, (_, i) => `!Sample_characteristics,ch1,EGFR status: ${i % 2 === 0 ? "positive" : "negative"}`);
    const content = lines.join("\n");
    const assetId = await registerTextAsset("soft_large.txt", Buffer.from(content, "utf8"));

    const middle = await readPage(preview, { asset_id: assetId, offset: 100_000, length: 200 });
    expect(middle.head).toBe(content.slice(100_000, 100_200));
    expect(middle.characters).toBe(200);
    expect(middle.truncated).toBe(true);

    const tail = await readPage(preview, { asset_id: assetId, offset: content.length - 10 });
    expect(tail.head).toBe(content.slice(content.length - 10));
    expect(tail.characters).toBe(10);
    expect(tail.truncated).toBe(false);
  });

  it("pages by characters, not bytes, across multi-byte boundaries", async () => {
    const { preview, registerTextAsset } = await createFixture("task_paging_utf8");
    const content = "中".repeat(10_000);
    const assetId = await registerTextAsset("cjk.txt", Buffer.from(content, "utf8"));
    const page = await readPage(preview, { asset_id: assetId, offset: 9_996, length: 4 });
    expect(page.head).toBe("中中中中");
    expect(page.characters).toBe(4);
    expect(page.truncated).toBe(false);
  });

  it("pages decoded gzip text with offsets", async () => {
    const { preview, registerTextAsset } = await createFixture("task_paging_gzip");
    const content = Array.from({ length: 2_000 }, (_, i) => `row,${i}`).join("\n");
    const assetId = await registerTextAsset("table.csv.gz", gzipSync(Buffer.from(content, "utf8")));
    const page = await readPage(preview, { asset_id: assetId, offset: 3_000, length: 12 });
    expect(page.head).toBe(content.slice(3_000, 3_012));
    expect(page.truncated).toBe(true);
  });

  it("pages decoded zip member text", async () => {
    const { preview, registerTextAsset } = await createFixture("task_paging_zip");
    const content = "gene_id\tvalue\n" + Array.from({ length: 5_000 }, (_, i) => `G${i},1`).join("\n");
    const assetId = await registerTextAsset("supplement.zip", storedZip([
      { name: "member_table.tsv", data: Buffer.from(content, "utf8") },
    ]));
    const page = await readPage(preview, { asset_id: assetId, member: "member_table.tsv", offset: 500, length: 20 });
    expect(page.head).toBe(content.slice(500, 520));
    expect(page.truncated).toBe(true);
  });

  it("keeps the member listing text-window-free and enforces the page ceiling", async () => {
    const { preview, registerTextAsset } = await createFixture("task_paging_guards");
    const assetId = await registerTextAsset("supplement.zip", storedZip([
      { name: "member_table.tsv", data: Buffer.from("gene_id\tvalue\nG0,1\n", "utf8") },
    ]));
    const listing = await readPage(preview, { asset_id: assetId, offset: 0 });
    expect(listing.ok).toBe(false);
    expect(listing.error?.message).toMatch(/offset\/length page text content/);

    const text = await registerTextAsset("soft.txt", Buffer.from("a".repeat(16), "utf8"));
    const oversized = await readPage(preview, { asset_id: text, length: 65_537 });
    expect(oversized.ok).toBe(false);
    expect(oversized.error?.message).toMatch(/between 1 and 65536/);

    const negative = await readPage(preview, { asset_id: text, offset: -1 });
    expect(negative.ok).toBe(false);
    expect(negative.error?.message).toMatch(/non-negative integer/);
  });
});
