import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BioMedAgentTool, BioMedToolResult } from "../contracts.js";
import { isZipArchive, listZipMembers, readZipMemberBytes } from "../../dataset/transform-host/zip.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";

/**
 * Core-owned archive access for agents: preview lists/reads what a Core asset
 * actually contains, and extract registers a decoded archive member as a new
 * Core asset so transforms can bind clean text instead of opaque binary.
 * Decode happens inside the Host (stdlib zip reader) — no agent-supplied
 * scripts, no subprocess, full provenance via SourceAssetRegistry receipts.
 */

const ASSET_ID_PATTERN = /^asset_[0-9a-f]{64}$/;
const PREVIEW_HEAD_CHARS = 8192;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CoreAssetToolOptions {
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
}> {
  const resolved = await options.sourceAssetRegistry.resolveAny(assetId);
  const registration = resolved.registration_receipt;
  const filePath = assetFilePath(options.sourceAssetsRoot, registration.relative_path);
  const bytes = await readFile(filePath);
  return { bytes, relativePath: registration.relative_path, mediaType: registration.media_type };
}

function textHead(bytes: Uint8Array): { head: string; truncated: boolean } {
  const slice = bytes.subarray(0, PREVIEW_HEAD_CHARS);
  const head = Buffer.from(slice).toString("utf8");
  return { head, truncated: bytes.byteLength > PREVIEW_HEAD_CHARS };
}

export function createPreviewCoreAssetTool(
  options: CoreAssetToolOptions,
): BioMedAgentTool {
  return {
    name: "preview_core_asset",
    label: "Preview Core Asset",
    description:
      "Read-only window into a task-owned Core asset. For a binary_archive (zip) asset without 'member', returns the member listing (names and sizes); with 'member', returns that member's decoded head text. For text assets returns the head text. Use this to inspect downloaded archives and see the exact text a transform would receive — never use python/shell/workspace_exec for this.",
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
        if (request.member !== undefined && (typeof request.member !== "string" || request.member.length === 0)) {
          throw new TypeError("member must be a non-empty string when provided");
        }
        const { bytes, relativePath, mediaType } = await loadAssetBytes(options, request.asset_id);
        if (!isZipArchive(bytes)) {
          const head = textHead(bytes);
          return {
            content: JSON.stringify({
              ok: true,
              asset_id: request.asset_id,
              relative_path: relativePath,
              media_type: mediaType,
              size_bytes: bytes.byteLength,
              ...head,
            }),
            details: { ok: true },
          };
        }
        const members = listZipMembers(bytes);
        if (request.member === undefined) {
          return {
            content: JSON.stringify({
              ok: true,
              asset_id: request.asset_id,
              relative_path: relativePath,
              is_zip: true,
              member_count: members.length,
              members: members.slice(0, 128),
            }),
            details: { ok: true },
          };
        }
        const memberBytes = readZipMemberBytes(bytes, request.member);
        const head = textHead(memberBytes);
        return {
          content: JSON.stringify({
            ok: true,
            asset_id: request.asset_id,
            member: request.member,
            size_bytes: memberBytes.byteLength,
            ...head,
          }),
          details: { ok: true },
        };
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
      "Extract one member of a task-owned zip asset into a NEW Core asset (deterministic Host-side decode, provenance receipt included). Returns the new asset_id to bind in prepare_dynamic_family_publication registered_sources. This is the formal path for binary_archive sources — never extract via python/shell/workspace_exec.",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string", pattern: ASSET_ID_PATTERN.source },
        member: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["asset_id", "member"],
      additionalProperties: false,
    },
    async execute(value): Promise<BioMedToolResult> {
      try {
        const request = value as { asset_id?: unknown; member?: unknown };
        if (typeof request.asset_id !== "string" || !ASSET_ID_PATTERN.test(request.asset_id)) {
          throw new TypeError("asset_id must be an asset_<sha256> id");
        }
        if (typeof request.member !== "string" || request.member.length === 0) {
          throw new TypeError("member is required");
        }
        const { bytes } = await loadAssetBytes(options, request.asset_id);
        if (!isZipArchive(bytes)) {
          throw new TypeError("asset is not a zip archive");
        }
        const memberBytes = readZipMemberBytes(bytes, request.member);
        const baseName = path.posix.basename(request.member.replaceAll("\\", "/"));
        if (!SAFE_FILE_NAME.test(baseName)) {
          throw new TypeError(
            `member file name '${baseName}' is not a safe file name; extract a member with a simple name (letters, digits, dot, dash, underscore)`,
          );
        }
        const derivedDir = `source_assets/extract/${request.asset_id.slice("asset_".length, "asset_".length + 12)}`;
        await mkdir(path.resolve(options.sourceAssetsRoot, derivedDir), { recursive: true });
        const memberRelative = `${derivedDir}/${baseName}`;
        await writeFile(path.resolve(options.sourceAssetsRoot, memberRelative), memberBytes);
        const receipt = await options.sourceAssetRegistry.register({
          sourceId: `extract_${request.asset_id.slice("asset_".length, "asset_".length + 12)}`,
          relativePath: memberRelative,
        });
        return {
          content: JSON.stringify({
            ok: true,
            asset_id: receipt.asset_ref.asset_id,
            derived_from: request.asset_id,
            member: request.member,
            relative_path: receipt.relative_path,
            size_bytes: receipt.size_bytes,
            media_type: receipt.media_type,
          }),
          details: { ok: true },
        };
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
