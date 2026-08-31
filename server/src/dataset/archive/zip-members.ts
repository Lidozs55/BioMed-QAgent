import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import type {
  CoreDerivedAssetProvenance,
  OperationResultManifest,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";

import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;

export interface ArchiveExtractionLimits {
  maxMembers: number;
  maxMemberBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ARCHIVE_EXTRACTION_LIMITS: ArchiveExtractionLimits = Object.freeze({
  maxMembers: 512,
  maxMemberBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
});

export interface ArchiveMemberAsset {
  member_path: string;
  member_sha256: string;
  size_bytes: number;
  media_type: string;
  receipt: SourceAssetRegistrationReceipt;
  provenance: CoreDerivedAssetProvenance;
}

export interface ArchiveExtractionResult {
  schema_version: "1.0";
  operation_result_id: string;
  parent_archive_asset_id: string;
  parent_archive_sha256: string;
  members: readonly ArchiveMemberAsset[];
  operation_result: OperationResultManifest;
}

interface ZipEntry {
  name: string;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function mediaType(name: string): string {
  switch (path.posix.extname(name).toLowerCase()) {
    case ".csv": return "text/csv";
    case ".tsv": return "text/tab-separated-values";
    case ".txt": return "text/plain";
    case ".json": return "application/json";
    case ".xml": return "application/xml";
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

function safeMemberPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    normalized === ""
    || normalized.startsWith("/")
    || /^[A-Za-z]:/u.test(normalized)
    || parts.some((part) => part === "" || part === "." || part === "..")
    || normalized.includes("\u0000")
  ) {
    throw new TypeError(`ZIP member path is unsafe: '${value}'`);
  }
  return parts.join("/");
}

function findEocd(bytes: Buffer): number {
  const start = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new TypeError("ZIP end-of-central-directory record was not found");
}

function parseCentralDirectory(bytes: Buffer, limits: ArchiveExtractionLimits): ZipEntry[] {
  const eocd = findEocd(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new TypeError("multi-disk ZIP archives are not supported");
  }
  if (entryCount > limits.maxMembers) throw new TypeError("ZIP member count exceeds the Core limit");
  if (centralOffset + centralSize > eocd) throw new TypeError("ZIP central directory is out of bounds");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new TypeError(`ZIP central directory entry ${index} is malformed`);
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const expectedCrc32 = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new TypeError(`ZIP central directory entry ${index} is truncated`);
    if ((flags & 0x1) !== 0) throw new TypeError("encrypted ZIP members are not supported");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new TypeError("ZIP64 members are not supported by the bounded extractor");
    }
    if (compression !== 0 && compression !== 8) {
      throw new TypeError(`ZIP member ${index} uses unsupported compression method ${compression}`);
    }
    if (uncompressedSize > limits.maxMemberBytes) {
      throw new TypeError(`ZIP member ${index} exceeds the Core size limit`);
    }
    const decodedName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!decodedName.endsWith("/")) {
      const name = safeMemberPath(decodedName);
      if (names.has(name)) throw new TypeError(`ZIP contains duplicate member path '${name}'`);
      names.add(name);
      entries.push({ name, compression, crc32: expectedCrc32, compressedSize, uncompressedSize, localOffset });
    }
    offset = end;
  }
  return entries;
}

function extractEntry(bytes: Buffer, entry: ZipEntry, limits: ArchiveExtractionLimits): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new TypeError(`ZIP local header is missing for '${entry.name}'`);
  }
  const flags = bytes.readUInt16LE(offset + 6);
  const compression = bytes.readUInt16LE(offset + 8);
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const localName = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(offset + 30, offset + 30 + nameLength),
  );
  if ((flags & 0x1) !== 0 || compression !== entry.compression || safeMemberPath(localName) !== entry.name) {
    throw new TypeError(`ZIP local header does not match central entry '${entry.name}'`);
  }
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > bytes.length) throw new TypeError(`ZIP member '${entry.name}' is truncated`);
  const compressed = bytes.subarray(dataOffset, dataEnd);
  const output = entry.compression === 0
    ? Buffer.from(compressed)
    : inflateRawSync(compressed, { maxOutputLength: limits.maxMemberBytes });
  if (output.length !== entry.uncompressedSize) {
    throw new TypeError(`ZIP member '${entry.name}' size does not match its central directory`);
  }
  if (crc32(output) !== entry.crc32) {
    throw new TypeError(`ZIP member '${entry.name}' CRC32 does not match its central directory`);
  }
  return output;
}

async function collectBytes(
  content: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of content) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new TypeError("archive carrier exceeds the Core input limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Core-owned ZIP member extraction. It accepts only an acquired carrier with
 * verified task ownership and re-registers each member as a derived source
 * asset with parent archive and operation-result lineage.
 */
export async function extractRegisteredZipMembers(options: {
  taskId: string;
  taskRoot: string;
  archiveAssetId: string;
  sourceAssetRegistry: SourceAssetRegistry;
  limits?: Partial<ArchiveExtractionLimits>;
}): Promise<ArchiveExtractionResult> {
  const limits = Object.freeze({ ...DEFAULT_ARCHIVE_EXTRACTION_LIMITS, ...options.limits });
  const acquired = await options.sourceAssetRegistry.resolveCoreAcquired(
    options.archiveAssetId,
    undefined,
    "carrier",
  );
  if (!/^(?:application\/zip|application\/octet-stream)$/u.test(acquired.registration_receipt.media_type)) {
    throw new TypeError("archive member extraction requires a registered ZIP carrier");
  }
  const bytes = await collectBytes(acquired.content, limits.maxTotalBytes);
  if (digest(bytes) !== acquired.registration_receipt.sha256) {
    throw new Error("archive carrier hash changed before extraction");
  }
  const entries = parseCentralDirectory(bytes, limits);
  if (entries.length === 0) throw new TypeError("ZIP archive contains no file members");
  let totalOutput = 0;
  const parametersDigest = digest(JSON.stringify(limits));
  const operationResultId = `result_archive_${digest(`${options.archiveAssetId}\u0000${parametersDigest}`).slice(0, 32)}`;
  const members: ArchiveMemberAsset[] = [];
  for (const entry of entries) {
    const output = extractEntry(bytes, entry, limits);
    totalOutput += output.length;
    if (totalOutput > limits.maxTotalBytes) throw new TypeError("ZIP expanded bytes exceed the Core total limit");
    const memberSha256 = digest(output);
    const extension = path.posix.extname(entry.name).toLowerCase().replace(/[^.a-z0-9]/gu, "");
    const relativePath = `source_assets/archive-members/${acquired.registration_receipt.sha256}/${memberSha256}${extension}`;
    const absolutePath = path.join(options.taskRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, output, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const registered = await options.sourceAssetRegistry.registerDerived({
      sourceId: `archive_member_${memberSha256.slice(0, 24)}`,
      relativePath,
      role: "source",
      mediaType: mediaType(entry.name),
      parentAssetIds: [options.archiveAssetId],
      operationKind: "archive_member_extraction",
      operationResultId,
      implementationId: "dataset_core.zip_member_extractor",
      implementationVersion: "1.0.0",
      parametersDigest,
      evidence: {
        parent_archive_asset_id: options.archiveAssetId,
        parent_archive_sha256: acquired.registration_receipt.sha256,
        member_path: entry.name,
        member_sha256: memberSha256,
        registered_relative_path: relativePath,
        media_type: mediaType(entry.name),
        size_bytes: output.length,
        compressed_size_bytes: entry.compressedSize,
        uncompressed_size_bytes: output.length,
        compression_method: entry.compression,
        crc32: entry.crc32,
      },
    });
    if (registered.receipt.sha256 !== memberSha256) {
      throw new Error(`archive member '${entry.name}' registration did not preserve extracted bytes`);
    }
    members.push({
      member_path: entry.name,
      member_sha256: memberSha256,
      size_bytes: output.length,
      media_type: mediaType(entry.name),
      receipt: registered.receipt,
      provenance: registered.provenance,
    });
  }
  const operationImplementationDigest = digest("dataset_core.zip_member_extractor@1.0.0");
  const operationDigest = digest(members.map((member) => `${member.member_path}\u0000${member.member_sha256}`).join("\u0000"));
  const operationResult: OperationResultManifest = {
    schema_version: "1.0",
    result_manifest_id: operationResultId,
    task_id: options.taskId,
    run_id: "core",
    requirement_id: "archive_extraction",
    operation_id: operationResultId,
    operation_kind: "parse",
    operation_attempt_id: `attempt_${operationResultId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: acquired.registration_receipt.sha256,
    parameter_digest: parametersDigest,
    implementation_digest: operationImplementationDigest,
    output_digest: operationDigest,
    output_kind: "source_asset",
    output_summary: {
      parent_archive_asset_id: options.archiveAssetId,
      member_count: members.length,
      members: members.map((member) => ({
        member_path: member.member_path,
        asset_id: member.receipt.asset_ref.asset_id,
        member_sha256: member.member_sha256,
      })),
    },
    output_files: members.map((member) => ({
      relative_path: member.receipt.relative_path,
      size_bytes: member.receipt.size_bytes,
      sha256: member.member_sha256,
    })),
    dependency_closure: {
      input_asset_ids: [options.archiveAssetId],
      upstream_result_manifest_ids: [],
      parameter_digest: parametersDigest,
      implementation_digest: operationImplementationDigest,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${operationResultId}`,
      committed_at: members[0]?.provenance.created_at ?? acquired.registration_receipt.registered_at,
    },
  };
  await options.sourceAssetRegistry.recordDerivedOperationResult(operationResult);
  return Object.freeze({
    schema_version: "1.0",
    operation_result_id: operationResultId,
    parent_archive_asset_id: options.archiveAssetId,
    parent_archive_sha256: acquired.registration_receipt.sha256,
    members: Object.freeze(members),
    operation_result: operationResult,
  });
}
