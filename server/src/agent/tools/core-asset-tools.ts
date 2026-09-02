import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { OperationResultManifest } from "@biomed/contracts";

import type { BioMedAgentTool, BioMedToolResult } from "../contracts.js";
import {
  extractZipMember,
  readZipCentralDirectory,
  type ZipMemberEntry,
} from "../../dataset/acquisition/zip-members.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
import { mediaTypeFor } from "./import-tools.js";

/**
 * Core-owned archive access for agents: preview lists/reads what a Core asset
 * actually contains, and extract registers a decoded archive member as a new
 * Core asset so transforms can bind clean text instead of opaque binary.
 * Decode happens inside the Host (stdlib zip reader) — no agent-supplied
 * scripts, no subprocess, full provenance via SourceAssetRegistry receipts.
 */

const ASSET_ID_PATTERN = /^asset_[0-9a-f]{64}$/;
const PREVIEW_HEAD_CHARS = 8192;
// Same per-call ceiling as workspace_read's maxReadCharacters (M2: large
// carriers like a 153 MB SOFT file must be paged, not just headed).
const PREVIEW_MAX_PAGE_CHARS = 64 * 1024;
// Upper bound for decoding asset bytes into pageable text; matches the gzip /
// zip-member extraction ceilings. Assets beyond it page only their prefix.
const PREVIEW_MAX_DECODE_BYTES = 256 * 1024 * 1024;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CoreAssetToolOptions {
  readonly taskId: string;
  readonly sourceAssetRegistry: SourceAssetRegistry;
  /** The registry root directory (contains ``source_assets/``). */
  readonly sourceAssetsRoot: string;
}

function assetFilePath(sourceAssetsRoot: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const candidate = path.resolve(sourceAssetsRoot, normalized);
  if (!candidate.startsWith(path.resolve(sourceAssetsRoot) + path.sep)) {
    throw new TypeError("asset relative path escaped the source_assets root");
  }
  return candidate;
}

async function loadAssetBytes(options: CoreAssetToolOptions, assetId: string): Promise<{
  bytes: Buffer;
  relativePath: string;
  mediaType: string;
  sha256: string;
}> {
  const resolved = await options.sourceAssetRegistry.resolveAny(assetId);
  const registration = resolved.registration_receipt;
  const filePath = assetFilePath(options.sourceAssetsRoot, registration.relative_path);
  const bytes = await readFile(filePath);
  return { bytes, relativePath: registration.relative_path, mediaType: registration.media_type, sha256: registration.sha256 };
}

/**
 * Decode asset bytes into pageable text and select one character window.
 * Offset/length are CHARACTERS of the decoded UTF-8 text (workspace_read
 * semantics — model-blockers M2: a fixed head window left the middle of a
 * 153 MB SOFT carrier unreachable, and the model chose to report without the
 * field rather than fabricate it). When the asset exceeds the decode ceiling
 * only the prefix is decodable and ``truncated`` stays true.
 */
function decodePage(bytes: Buffer, offset: number, length: number): {
  head: string;
  offset: number;
  characters: number;
  truncated: boolean;
} {
  const clamped = bytes.byteLength > PREVIEW_MAX_DECODE_BYTES;
  const text = (clamped ? bytes.subarray(0, PREVIEW_MAX_DECODE_BYTES) : bytes).toString("utf8");
  const selected = text.slice(offset, offset + length);
  return {
    head: selected,
    offset,
    characters: selected.length,
    truncated: clamped || offset + selected.length < text.length,
  };
}

function parsePreviewWindow(value: { offset?: unknown; length?: unknown }): {
  offset: number;
  length: number;
} {
  const offset = value.offset ?? 0;
  const length = value.length ?? PREVIEW_HEAD_CHARS;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("offset must be a non-negative integer");
  }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0
    || length > PREVIEW_MAX_PAGE_CHARS) {
    throw new TypeError(`length must be an integer between 1 and ${PREVIEW_MAX_PAGE_CHARS}`);
  }
  return { offset, length };
}

function isZipArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function isGzipArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Decompress a single gzip member so the model can inspect the exact text a
 * transform would receive — the previous behavior surfaced raw gzip binary
 * (model-blockers B1/C1/D1: ".gz preview returns binary"). Bounded, not
 * unbounded: decompression is capped at the same extraction ceiling zip
 * members use.
 */
function gunzipMemberBytes(bytes: Buffer): Buffer {
  try {
    const out = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  } catch (error) {
    throw new TypeError("asset is not a readable gzip stream", { cause: error });
  }
}

/** Strip a ``.gz`` suffix so ``xxx.csv.gz`` registers as ``text/csv``. */
function bareGzipName(member: string): string {
  const bare = member.replace(/\.gz$/i, "");
  if (bare === "") throw new TypeError("gzip member name is not a safe file name");
  return bare;
}

function zipMembers(bytes: Buffer): readonly ZipMemberEntry[] {
  const members = readZipCentralDirectory(bytes);
  if (members.length > 4096) throw new TypeError("zip archive exceeds the 4096-member cap");
  return members;
}

function zipMemberBytes(bytes: Buffer, memberName: string): Buffer {
  const member = zipMembers(bytes).find((entry) => entry.name === memberName);
  if (member === undefined) throw new TypeError(`zip member '${memberName}' not found in archive`);
  if (member.uncompressedSize > 256 * 1024 * 1024) {
    throw new TypeError(`zip member '${memberName}' exceeds the 268435456-byte extraction cap`);
  }
  return extractZipMember(bytes, member);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function registerExtractedAsset(options: CoreAssetToolOptions, input: {
  parentAssetId: string;
  parentSha256: string;
  member: string | null;
  baseName: string;
  bytes: Buffer;
  mediaType: string;
}): Promise<{
  receipt: Awaited<ReturnType<SourceAssetRegistry["registerDerived"]>>["receipt"];
  operationResultId: string;
}> {
  await options.sourceAssetRegistry.resolveFormalProvenanceClosure(input.parentAssetId);
  const memberSha256 = sha256(input.bytes);
  const parameters = {
    parent_asset_id: input.parentAssetId,
    member: input.member,
    media_type: input.mediaType,
  };
  const parametersDigest = sha256(JSON.stringify(parameters));
  const operationResultId = `result_archive_${sha256(`${input.parentAssetId}\u0000${parametersDigest}`).slice(0, 32)}`;
  const implementationDigest = sha256("dataset_core.core_asset_extractor@1.0.0");
  const relativePath = `source_assets/extract/${input.parentAssetId.slice("asset_".length, "asset_".length + 12)}/${memberSha256}${path.posix.extname(input.baseName).toLowerCase()}`;
  const absolutePath = path.resolve(options.sourceAssetsRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const registered = await options.sourceAssetRegistry.registerDerived({
    sourceId: `extract_${memberSha256.slice(0, 24)}`,
    relativePath,
    role: "source",
    mediaType: input.mediaType,
    parentAssetIds: [input.parentAssetId],
    operationKind: "archive_member_extraction",
    operationResultId,
    implementationId: "dataset_core.core_asset_extractor",
    implementationVersion: "1.0.0",
    parametersDigest,
    evidence: {
      parent_archive_asset_id: input.parentAssetId,
      parent_archive_sha256: input.parentSha256,
      member_path: input.member,
      member_sha256: memberSha256,
      registered_relative_path: relativePath,
      media_type: input.mediaType,
      size_bytes: input.bytes.byteLength,
    },
  });
  if (registered.receipt.sha256 !== memberSha256) {
    throw new Error("archive extraction registration did not preserve decoded bytes");
  }
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
    input_digest: input.parentSha256,
    parameter_digest: parametersDigest,
    implementation_digest: implementationDigest,
    output_digest: memberSha256,
    output_kind: "source_asset",
    output_summary: {
      parent_archive_asset_id: input.parentAssetId,
      member_path: input.member,
      member_asset_id: registered.receipt.asset_ref.asset_id,
    },
    output_files: [{
      relative_path: registered.receipt.relative_path,
      size_bytes: registered.receipt.size_bytes,
      sha256: memberSha256,
    }],
    dependency_closure: {
      input_asset_ids: [input.parentAssetId],
      upstream_result_manifest_ids: [],
      parameter_digest: parametersDigest,
      implementation_digest: implementationDigest,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${operationResultId}`,
      committed_at: registered.provenance.created_at,
    },
  };
  await options.sourceAssetRegistry.recordDerivedOperationResult(operationResult);
  return { receipt: registered.receipt, operationResultId };
}

export function createPreviewCoreAssetTool(
  options: CoreAssetToolOptions,
): BioMedAgentTool {
  return {
    name: "preview_core_asset",
    label: "Preview Core Asset",
    description:
      "Read-only window into a task-owned Core asset. For a binary_archive (zip) asset without 'member', returns the member listing (names and sizes); with 'member', returns that member's decoded text. For text and gzip assets returns the decoded text. Text is paged with 'offset'/'length' in CHARACTERS of the decoded UTF-8 text (like workspace_read; default offset 0, length 8192; at most 65536 characters per call — page with larger offsets to reach the middle of large files, and use 'truncated' to see whether text remains). Use this to inspect downloaded archives and see the exact text a transform would receive — never use python/shell/workspace_exec for this.",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string", pattern: ASSET_ID_PATTERN.source },
        member: { type: "string", minLength: 1, maxLength: 256 },
        offset: { type: "integer", minimum: 0, description: "Character offset into the decoded text (0 = start)." },
        length: { type: "integer", minimum: 1, maximum: 65536, description: "Max characters to return (default 8192)." },
      },
      required: ["asset_id"],
      additionalProperties: false,
    },
    async execute(value): Promise<BioMedToolResult> {
      try {
        const request = value as { asset_id?: unknown; member?: unknown; offset?: unknown; length?: unknown };
        if (typeof request.asset_id !== "string" || !ASSET_ID_PATTERN.test(request.asset_id)) {
          throw new TypeError("asset_id must be an asset_<sha256> id");
        }
        if (request.member !== undefined && (typeof request.member !== "string" || request.member.length === 0)) {
          throw new TypeError("member must be a non-empty string when provided");
        }
        const { offset, length } = parsePreviewWindow(request);
        const { bytes, relativePath, mediaType } = await loadAssetBytes(options, request.asset_id);
        if (isZipArchive(bytes)) {
          const members = zipMembers(bytes);
          if (request.member === undefined) {
            if (request.offset !== undefined || request.length !== undefined) {
              throw new TypeError("offset/length page text content; omit them for the member listing");
            }
            return {
              content: JSON.stringify({
                ok: true,
                asset_id: request.asset_id,
                relative_path: relativePath,
                is_zip: true,
                member_count: members.length,
                members: members.slice(0, 128).map((member) => ({
                  name: member.name,
                  compressedBytes: member.compressedSize,
                  uncompressedBytes: member.uncompressedSize,
                  method: member.method,
                })),
              }),
              details: { ok: true },
            };
          }
          const memberBytes = zipMemberBytes(bytes, request.member);
          const page = decodePage(memberBytes, offset, length);
          return {
            content: JSON.stringify({
              ok: true,
              asset_id: request.asset_id,
              member: request.member,
              size_bytes: memberBytes.byteLength,
              ...page,
            }),
            details: { ok: true },
          };
        }
        if (isGzipArchive(bytes)) {
          const decoded = gunzipMemberBytes(bytes);
          const page = decodePage(decoded, offset, length);
          return {
            content: JSON.stringify({
              ok: true,
              asset_id: request.asset_id,
              relative_path: relativePath,
              is_gzip: true,
              decoded_size_bytes: decoded.byteLength,
              media_type: mediaTypeFor(bareGzipName(relativePath)),
              ...page,
            }),
            details: { ok: true },
          };
        }
        {
          const page = decodePage(bytes, offset, length);
          return {
            content: JSON.stringify({
              ok: true,
              asset_id: request.asset_id,
              relative_path: relativePath,
              media_type: mediaType,
              size_bytes: bytes.byteLength,
              ...page,
            }),
            details: { ok: true },
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: JSON.stringify({ ok: false, error: { code: "core_asset_preview_rejected", message } }),
          details: { ok: false, error: { code: "core_asset_preview_rejected", message } },
          isError: true,
        };
      }
    },
  };
}

export function createExtractCoreArchiveTool(
  options: CoreAssetToolOptions,
): BioMedAgentTool {
  return {
    name: "extract_core_archive",
    label: "Extract Core Archive Member",
    description:
      "Extract one member of a task-owned zip asset, or decode a single-member gzip asset, into a NEW Core asset (deterministic Host-side decode, provenance receipt included). Returns the new asset_id to bind in prepare_dynamic_family_publication registered_sources. For a gzip asset, omit 'member' to decode the whole stream; the extracted text is registered with its true media type (e.g. xxx.csv.gz -> text/csv). This is the formal path for binary_archive sources — never extract via python/shell/workspace_exec.",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string", pattern: ASSET_ID_PATTERN.source },
        member: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["asset_id"],
      additionalProperties: false,
    },
    async execute(value): Promise<BioMedToolResult> {
      try {
        const request = value as { asset_id?: unknown; member?: unknown };
        if (typeof request.asset_id !== "string" || !ASSET_ID_PATTERN.test(request.asset_id)) {
          throw new TypeError("asset_id must be an asset_<sha256> id");
        }
        const { bytes, relativePath, sha256: parentSha256 } = await loadAssetBytes(options, request.asset_id);
        if (isZipArchive(bytes)) {
          if (typeof request.member !== "string" || request.member.length === 0) {
            throw new TypeError("member is required for zip archives");
          }
          const memberBytes = zipMemberBytes(bytes, request.member);
          const baseName = path.posix.basename(request.member.replaceAll("\\", "/"));
          if (!SAFE_FILE_NAME.test(baseName)) {
            throw new TypeError(
              `member file name '${baseName}' is not a safe file name; extract a member with a simple name (letters, digits, dot, dash, underscore)`,
            );
          }
          const extracted = await registerExtractedAsset(options, {
            parentAssetId: request.asset_id,
            parentSha256,
            member: request.member,
            baseName,
            bytes: memberBytes,
            mediaType: mediaTypeFor(baseName),
          });
          return {
            content: JSON.stringify({
              ok: true,
              asset_id: extracted.receipt.asset_ref.asset_id,
              derived_from: request.asset_id,
              member: request.member,
              relative_path: extracted.receipt.relative_path,
              size_bytes: extracted.receipt.size_bytes,
              media_type: extracted.receipt.media_type,
              operation_result_id: extracted.operationResultId,
            }),
            details: { ok: true },
          };
        }
        if (isGzipArchive(bytes)) {
          // gzip is a single-member format; decode the whole stream and
          // register the text with its true (de-suffixed) media type.
          const decoded = gunzipMemberBytes(bytes);
          const baseName = path.posix.basename(bareGzipName(relativePath).replaceAll("\\", "/"));
          if (!SAFE_FILE_NAME.test(baseName)) {
            throw new TypeError(
              `gzip member file name '${baseName}' is not a safe file name; extract an asset with a simple name`,
            );
          }
          const extracted = await registerExtractedAsset(options, {
            parentAssetId: request.asset_id,
            parentSha256,
            member: null,
            baseName,
            bytes: decoded,
            mediaType: mediaTypeFor(baseName),
          });
          return {
            content: JSON.stringify({
              ok: true,
              asset_id: extracted.receipt.asset_ref.asset_id,
              derived_from: request.asset_id,
              member: null,
              relative_path: extracted.receipt.relative_path,
              size_bytes: extracted.receipt.size_bytes,
              media_type: extracted.receipt.media_type,
              operation_result_id: extracted.operationResultId,
            }),
            details: { ok: true },
          };
        }
        throw new TypeError("asset is not a zip or gzip archive");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: JSON.stringify({ ok: false, error: { code: "core_archive_extract_rejected", message } }),
          details: { ok: false, error: { code: "core_archive_extract_rejected", message } },
          isError: true,
        };
      }
    },
  };
}

export function createCoreAssetTools(
  options: CoreAssetToolOptions,
): readonly [BioMedAgentTool, BioMedAgentTool] {
  return [createPreviewCoreAssetTool(options), createExtractCoreArchiveTool(options)];
}
