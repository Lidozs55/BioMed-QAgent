import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { isZipArchive, listZipMembers, readZipMemberBytes } from "./zip.js";

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value & 0xff00) >>> 8, (value & 0xff0000) >>> 16, (value >>> 24) & 0xff);
}

function concat(parts: ReadonlyArray<Uint8Array>): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

interface EntrySpec {
  readonly name: string;
  readonly data: Buffer;
  readonly deflate: boolean;
}

function buildZip(entries: ReadonlyArray<EntrySpec>): Buffer {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localBytes = 0;
  for (const entry of entries) {
    const compressed = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const nameBytes = Buffer.from(entry.name, "utf8");
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(0), u32(compressed.byteLength), u32(entry.data.byteLength),
      u16(nameBytes.byteLength), u16(0), nameBytes, compressed,
    ]);
    localParts.push(local);
    localBytes += local.byteLength;
    const central = concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0),
      u16(0), u32(0), u32(compressed.byteLength), u32(entry.data.byteLength),
      u16(nameBytes.byteLength), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(localBytes - local.byteLength), nameBytes,
    ]);
    centralParts.push(central);
  }
  const centralStart = localBytes;
  const directory = concat(centralParts);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.byteLength), u32(centralStart), u16(0),
  ]);
  return concat([...localParts, directory, eocd]);
}

describe("zip reader", () => {
  it("lists and reads stored and deflate members", () => {
    const archive = buildZip([
      { name: "data/a.csv", data: Buffer.from("id,value\n1,2\n", "utf8"), deflate: false },
      { name: "notes/readme.txt", data: Buffer.from("hello zip\n".repeat(40), "utf8"), deflate: true },
    ]);
    expect(isZipArchive(archive)).toBe(true);
    const members = listZipMembers(archive);
    expect(members.map((member) => member.name)).toEqual(["data/a.csv", "notes/readme.txt"]);
    expect(members[0]).toMatchObject({ method: 0, uncompressedBytes: 13 });
    expect(members[1]).toMatchObject({ method: 8 });
    expect(Buffer.from(readZipMemberBytes(archive, "data/a.csv")).toString("utf8")).toBe("id,value\n1,2\n");
    expect(Buffer.from(readZipMemberBytes(archive, "notes/readme.txt")).toString("utf8")).toBe("hello zip\n".repeat(40));
  });

  it("rejects non-zip bytes and unknown members", () => {
    expect(isZipArchive(Buffer.from("plain text", "utf8"))).toBe(false);
    const archive = buildZip([{ name: "only.bin", data: Buffer.from([1, 2, 3]), deflate: false }]);
    expect(() => readZipMemberBytes(archive, "missing.bin")).toThrow(/not found/);
  });
});
