import { inflateRawSync } from "node:zlib";

/**
 * Minimal read-only ZIP reader (stdlib only). Serves the Core-owned archive
 * preview/extract tools: agents may list members and read decoded member bytes
 * without shelling out to python/7z, keeping the decode on the provenance
 * chain. Write support is intentionally absent.
 */

export interface ZipMemberInfo {
  readonly name: string;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  /** 0 = stored, 8 = deflate; other methods are listed but unreadable here. */
  readonly method: number;
}

const MAX_ENTRIES = 4096;
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;
const EOCD_SCAN_BYTES = 66_000;

export function isZipArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function findEocdOffset(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - EOCD_SCAN_BYTES);
  for (let index = bytes.length - 22; index >= start; index -= 1) {
    if (
      bytes[index] === 0x50 && bytes[index + 1] === 0x4b
      && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06
    ) {
      return index;
    }
  }
  throw new TypeError("not a readable zip archive: end-of-central-directory not found");
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function decodeName(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, length).toString("utf8");
}

export function listZipMembers(bytes: Uint8Array): readonly ZipMemberInfo[] {
  const eocd = findEocdOffset(bytes);
  const directorySize = u32(bytes, eocd + 12);
  const directoryOffset = u32(bytes, eocd + 16);
  const members: ZipMemberInfo[] = [];
  let cursor = directoryOffset;
  const directoryEnd = directoryOffset + directorySize;
  while (cursor + 46 <= directoryEnd && cursor + 46 <= bytes.length) {
    if (u32(bytes, cursor) !== 0x02014b50) break;
    const method = u16(bytes, cursor + 10);
    const compressedBytes = u32(bytes, cursor + 20);
    const uncompressedBytes = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const name = decodeName(bytes, cursor + 46, nameLength);
    members.push({ name, compressedBytes, uncompressedBytes, method });
    cursor += 46 + nameLength + u16(bytes, cursor + 30) + u16(bytes, cursor + 32);
    if (members.length >= MAX_ENTRIES) break;
  }
  return members;
}

export function readZipMemberBytes(archive: Uint8Array, memberName: string): Uint8Array {
  const member = listZipMembers(archive).find((entry) => entry.name === memberName);
  if (member === undefined) {
    throw new TypeError(`zip member '${memberName}' not found in archive`);
  }
  if (member.uncompressedBytes > MAX_MEMBER_BYTES) {
    throw new TypeError(`zip member '${memberName}' exceeds the ${MAX_MEMBER_BYTES}-byte extraction cap`);
  }
  const eocd = findEocdOffset(archive);
  const directoryOffset = u32(archive, eocd + 16);
  let cursor = directoryOffset;
  for (;;) {
    if (cursor + 46 > archive.length || u32(archive, cursor) !== 0x02014b50) {
      throw new TypeError(`zip member '${memberName}' directory entry vanished`);
    }
    const nameLength = u16(archive, cursor + 28);
    const extraLength = u16(archive, cursor + 30);
    const name = decodeName(archive, cursor + 46, nameLength);
    const method = u16(archive, cursor + 10);
    const compressedBytes = u32(archive, cursor + 20);
    const uncompressedBytes = u32(archive, cursor + 24);
    if (name === memberName) {
      const localOffset = u32(archive, cursor + 42);
      if (u32(archive, localOffset) !== 0x04034b50) {
        throw new TypeError(`zip member '${memberName}' has an unreadable local header`);
      }
      const localNameLength = u16(archive, localOffset + 26);
      const localExtraLength = u16(archive, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataStart, dataStart + compressedBytes);
      if (method === 0) return compressed.slice();
      if (method === 8) {
        const inflated = inflateRawSync(compressed, { maxOutputLength: MAX_MEMBER_BYTES });
        if (inflated.byteLength !== uncompressedBytes) {
          throw new TypeError(`zip member '${memberName}' inflated size mismatch`);
        }
        return inflated;
      }
      throw new TypeError(`zip member '${memberName}' uses unsupported compression method ${method}`);
    }
    cursor += 46 + nameLength + extraLength + u16(archive, cursor + 32);
  }
}
