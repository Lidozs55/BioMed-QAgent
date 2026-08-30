/**
 * Import-session tools (LLM-driven cleaning flow, Python parity).
 *
 * Import tasks receive these tools in addition to the normal business bundle
 * so the agent can inspect the user-uploaded files (staged under
 * ``<taskRoot>/source_assets/``) and commit the cleaned raw files into the
 * global dataset cache under the ``user_import`` namespace:
 *
 * - ``list_source_assets`` — names + sizes of the uploaded files.
 * - ``read_source_asset`` — text preview of one uploaded file (bounded).
 * - ``commit_to_cache`` — commit one uploaded file as a raw asset into the
 *   global cache (content-addressed; re-importing identical bytes overwrites
 *   the same record).
 *
 * Everything here is deterministic and local (no network).
 */

import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { BRIDGE_OP, type DatabaseClient } from "../../persistence/db-client.js";
import type { BioMedAgentTool } from "../contracts.js";

const SOURCE_ASSETS_DIR = "source_assets";
const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEW_MAX_CHARS = 20_000;
const BINARY_SNIFF = 4096;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".json": "application/json",
  ".xml": "application/xml",
  ".gz": "application/gzip",
  ".gzip": "application/gzip",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pdf": "application/pdf",
  ".sdf": "chemical/x-mdl-sdfile",
  ".mol": "chemical/x-mdl-molfile",
  ".pdb": "chemical/x-pdb",
  ".cif": "chemical/x-cif",
  ".tsv.gz": "application/gzip",
  ".csv.gz": "application/gzip",
};

/** Extension-based media type (case-insensitive, deterministic); shared with
 * the Core asset tools so extracted archive members register true types. */
export function mediaTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  for (const suffix of [".tsv.gz", ".csv.gz", ".gz", ".zip", ".xlsx", ".xls", ".pdf", ".csv", ".tsv", ".txt", ".json", ".xml", ".sdf", ".mol", ".pdb", ".cif"]) {
    if (lower.endsWith(suffix)) return MEDIA_TYPES[suffix] ?? "application/octet-stream";
  }
  return "application/octet-stream";
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function resolveAssetPath(taskRoot: string, filename: string): string {
  const resolved = path.resolve(taskRoot, SOURCE_ASSETS_DIR, filename);
  const root = path.resolve(taskRoot, SOURCE_ASSETS_DIR);
  if (path.relative(root, resolved).startsWith("..")) {
    throw new Error("unsafe source asset filename");
  }
  return resolved;
}

export interface ImportToolsOptions {
  taskRoot: string;
  db: DatabaseClient;
}

export function createImportTools(options: ImportToolsOptions): BioMedAgentTool[] {
  const assetsRoot = path.join(options.taskRoot, SOURCE_ASSETS_DIR);
  const db = options.db;

  const listSourceAssets: BioMedAgentTool = {
    name: "list_source_assets",
    label: "List uploaded source files",
    description:
      "List the user-uploaded source files staged for this import task " +
      "(name + size in bytes). The files live under source_assets/ and can be " +
      "inspected with read_source_asset and committed to the local cache with " +
      "commit_to_cache.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async () => {
      const items: Array<{ name: string; size_bytes: number }> = [];
      try {
        const entries = await readdir(assetsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const file = path.join(assetsRoot, entry.name);
          const info = await stat(file);
          items.push({ name: entry.name, size_bytes: info.size });
        }
      } catch (error) {
        return {
          content: JSON.stringify({
            error: `cannot read source_assets: ${error instanceof Error ? error.message : String(error)}`,
          }),
          isError: true,
        };
      }
      return { content: JSON.stringify({ source: "user_import", files: items }) };
    },
  };

  const readSourceAsset: BioMedAgentTool = {
    name: "read_source_asset",
    label: "Read uploaded source file",
    description:
      "Read a text preview of one uploaded source file (first 512 KiB / 20k " +
      "characters). Binary content is reported as such with a header sniff " +
      "instead of raw bytes. Use list_source_assets to discover filenames.",
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Name of the uploaded file under source_assets/.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as { filename?: unknown };
      const filename = typeof record.filename === "string" ? record.filename : "";
      if (filename === "") {
        return { content: JSON.stringify({ error: "filename is required" }), isError: true };
      }
      let file: string;
      try {
        file = resolveAssetPath(options.taskRoot, filename);
        await stat(file);
      } catch (error) {
        return {
          content: JSON.stringify({
            error: `cannot read source asset: ${error instanceof Error ? error.message : String(error)}`,
          }),
          isError: true,
        };
      }
      const handle = await open(file, "r");
      try {
        const header = Buffer.alloc(BINARY_SNIFF);
        const { bytesRead: headerRead } = await handle.read(header, 0, header.length, 0);
        const head = header.subarray(0, headerRead);
        if (head.includes(0)) {
          return {
            content: JSON.stringify({
              filename,
              binary: true,
              size_bytes: (await stat(file)).size,
              header_preview: head.toString("latin1").replace(/[^\x20-\x7e]/g, ".").slice(0, 512),
              note: "binary content; preview truncated to header bytes",
            }),
          };
        }
        const previewBuffer = Buffer.alloc(PREVIEW_MAX_BYTES);
        const { bytesRead } = await handle.read(previewBuffer, 0, previewBuffer.length, 0);
        const preview = previewBuffer.subarray(0, bytesRead).toString("utf8").slice(0, PREVIEW_MAX_CHARS);
        return {
          content: JSON.stringify({
            filename,
            binary: false,
            size_bytes: (await stat(file)).size,
            preview,
            truncated: bytesRead === PREVIEW_MAX_BYTES || preview.length === PREVIEW_MAX_CHARS,
          }),
        };
      } finally {
        await handle.close();
      }
    },
  };

  const commitToCache: BioMedAgentTool = {
    name: "commit_to_cache",
    label: "Commit file to local cache",
    description:
      "Commit one uploaded source file into the global local cache as a raw " +
      "dataset (namespace 'user_import'). The record is content-addressed: " +
      "committing identical bytes again overwrites the same dataset_id, so " +
      "re-imports are deduplicated. Returns the committed cache dataset summary. " +
      "After committing, the file is searchable via search_local_cache and " +
      "readable via get_cache_dataset.",
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Name of the uploaded file under source_assets/.",
        },
        topic: {
          type: "string",
          description: "Short topic label for the cache record (default: filename).",
        },
        description: {
          type: "string",
          description: "Optional human-readable description.",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Optional search keywords (FTS-indexed).",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as {
        filename?: unknown;
        topic?: unknown;
        description?: unknown;
        keywords?: unknown;
      };
      const filename = typeof record.filename === "string" ? record.filename : "";
      if (filename === "") {
        return { content: JSON.stringify({ error: "filename is required" }), isError: true };
      }
      let file: string;
      try {
        file = resolveAssetPath(options.taskRoot, filename);
        const info = await stat(file);
        if (!info.isFile()) throw new Error("not a file");
      } catch (error) {
        return {
          content: JSON.stringify({
            error: `cannot read source asset: ${error instanceof Error ? error.message : String(error)}`,
          }),
          isError: true,
        };
      }
      const keywords = Array.isArray(record.keywords)
        ? record.keywords.filter((value): value is string => typeof value === "string")
        : [];
      const importedAt = new Date().toISOString();
      try {
        const sha = await sha256File(file);
        const datasetId = `blob_${sha.slice(0, 16)}`;
        const topic = typeof record.topic === "string" && record.topic.trim() !== ""
          ? record.topic.trim()
          : filename;
        const description = typeof record.description === "string"
          ? record.description
          : `user-imported raw file ${filename}`;
        const sizeBytes = (await stat(file)).size;
        const manifest = await db.call<Record<string, unknown>>(BRIDGE_OP.CACHE_COMMIT, {
          dataset_id: datasetId,
          source_namespace: "user_import",
          topic,
          description,
          csv_rows: [
            {
              source_filename: filename,
              sha256: sha,
              size_bytes: String(sizeBytes),
              media_type: mediaTypeFor(filename),
              imported_at: importedAt,
            },
          ],
          columns: ["source_filename", "sha256", "size_bytes", "media_type", "imported_at"],
          created_by_task_id: "",
          source_files: [filename],
          keywords: [...keywords, filename],
          extra: {
            kind: "user_import",
            original_filename: filename,
          },
          asset_files: {
            [filename]: {
              path: file,
              media_type: mediaTypeFor(filename),
            },
          },
        });
        return {
          content: JSON.stringify({
            source: "user_import",
            committed: true,
            dataset: manifest,
          }),
        };
      } catch (error) {
        return {
          content: JSON.stringify({
            source: "user_import",
            committed: false,
            error: `cache commit failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
          isError: true,
        };
      }
    },
  };

  return [listSourceAssets, readSourceAsset, commitToCache];
}