/**
 * Minimal deterministic ZIP reader for Core-owned carrier extraction.
 *
 * Supports the subset produced by real publisher archives (Europe PMC
 * supplementaryFiles): STORE (method 0) and DEFLATE (method 8) entries read
 * through the central directory, with CRC-32 verification. ZIP64, encrypted
 * entries, multi-disk archives, and data-descriptor-only sizes are rejected
 * fail-closed — those are either out of policy or ambiguous provenance.
 * Only `node:zlib` is used; no third-party archive dependency.
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_COMMENT_BYTES = 65_535;
const EOCD_MIN_LENGTH = 22;

export interface ZipMemberEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipFormatError extends TypeError {}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const scanStart = Math.max(0, buffer.length - EOCD_MIN_LENGTH - MAX_EOCD_COMMENT_BYTES);
  for (let offset = buffer.length - EOCD_MIN_LENGTH; offset >= scanStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipFormatError("not a ZIP archive: end of central directory not found");
}

function entryName(buffer: Buffer, entry: { nameOffset: number; nameLength: number }): string {
  const raw = buffer.subarray(entry.nameOffset, entry.nameOffset + entry.nameLength).toString("utf-8");
  if (raw.includes("\0")) throw new ZipFormatError(`ZIP entry name contains a NUL byte: ${JSON.stringify(raw)}`);
  return raw;
}

/** Parse the central directory. ZIP64 and encrypted entries fail closed. */
export function readZipCentralDirectory(buffer: Buffer): ZipMemberEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || cdDisk !== 0) throw new ZipFormatError("multi-disk ZIP archives are not supported");
  if (cdOffset === 0xffffffff || totalEntries === 0xffff || cdSize === 0xffffffff) {
    throw new ZipFormatError("ZIP64 archives are not supported");
  }
  const entries: ZipMemberEntry[] = [];
  let offset = cdOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError(`corrupt central directory at entry ${index}`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    if ((flags & 0x0001) !== 0) throw new ZipFormatError(`encrypted ZIP entry ${index} is not supported`);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = entryName(buffer, { nameOffset: offset + 46, nameLength });
    entries.push({ name, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompress one member and verify its CRC-32 against the central directory. */
export function extractZipMember(buffer: Buffer, entry: ZipMemberEntry): Buffer {
  if (entry.localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError(`corrupt local header for entry ${JSON.stringify(entry.name)}`);
  }
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > buffer.length) throw new ZipFormatError(`truncated data for entry ${JSON.stringify(entry.name)}`);
  const compressed = buffer.subarray(dataOffset, dataEnd);
  let content: Buffer;
  if (entry.method === 0) {
    content = Buffer.from(compressed);
  } else if (entry.method === 8) {
    content = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
  } else {
    throw new ZipFormatError(`unsupported compression method ${entry.method} for entry ${JSON.stringify(entry.name)}`);
  }
  if (content.length !== entry.uncompressedSize) {
    throw new ZipFormatError(`size mismatch for entry ${JSON.stringify(entry.name)}: ${content.length} != ${entry.uncompressedSize}`);
  }
  if (crc32(content) !== entry.crc32) {
    throw new ZipFormatError(`CRC-32 mismatch for entry ${JSON.stringify(entry.name)}`);
  }
  return content;
}

/**
 * Select members safe to stage: regular files (no directory suffix), names
 * without traversal or absolute-path components, matching the extension
 * allowlist, and within the per-member and per-archive caps. Directory
 * prefixes are flattened into the stored name so provenance stays readable.
 */
export function selectExtractableZipMembers(
  entries: readonly ZipMemberEntry[],
  options: { extensions: readonly string[]; maxMembers: number; maxMemberBytes: number },
): Array<ZipMemberEntry & { storedName: string }> {
  const extensions = options.extensions.map((extension) => extension.toLowerCase());
  const selected: Array<ZipMemberEntry & { storedName: string }> = [];
  for (const entry of entries) {
    if (selected.length >= options.maxMembers) break;
    if (entry.name.endsWith("/") || entry.uncompressedSize === 0) continue;
    if (entry.uncompressedSize > options.maxMemberBytes) continue;
    const normalized = entry.name.replaceAll("\\", "/");
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) continue;
    const leaf = segments[segments.length - 1]!;
    if (!extensions.some((extension) => leaf.toLowerCase().endsWith(extension))) continue;
    if (/[A-Za-z]:/.test(segments[0]!) || normalized.startsWith("/")) continue;
    const storedName = `${segments.length > 1 ? `${segments.slice(0, -1).join("_").slice(0, 64)}_` : ""}${leaf}`.slice(0, 200);
    selected.push({ ...entry, storedName });
  }
  return selected;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) !== 0 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    table[value] = current >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let offset = 0; offset < buffer.length; offset += 1) {
    crc = CRC_TABLE[(crc ^ buffer[offset]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
