import { createReadStream, type ReadStream } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { DatasetPublication, ManifestArtifactEntry } from "@biomed/contracts";
import { sha256FileStreamWithSize } from "../dataset/adapters/hashing.js";
import { SAFE_ID } from "../runtime/safe-id.js";

const SHA256 = /^[0-9a-f]{64}$/u;

interface PublicationManifest extends Record<string, unknown> {
  task_id: string;
  requirement_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  row_count: number;
  sha256: string;
  artifacts: ManifestArtifactEntry[];
}

interface PublicationRecord {
  taskId: string;
  runId: string;
  requirementId: string;
  publicationId: string;
  publicationDir: string;
  manifestRef: string;
  manifest: PublicationManifest;
  publication: DatasetPublication;
  modifiedAt: number;
}

export interface StreamedArtifact {
  stream: ReadStream;
  sizeBytes: number;
  mediaType: string;
  name: string;
}

export class PublicationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationStoreError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicationStoreError(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function parseArtifact(value: unknown): ManifestArtifactEntry {
  const item = object(value, "Publication artifact");
  if (
    typeof item.artifact_id !== "string" || !SAFE_ID.test(item.artifact_id) ||
    typeof item.role !== "string" || item.role.length === 0 ||
    typeof item.relative_path !== "string" || item.relative_path.length === 0 ||
    typeof item.media_type !== "string" || item.media_type.length === 0 ||
    !Number.isInteger(item.size_bytes) || Number(item.size_bytes) < 0 ||
    typeof item.sha256 !== "string" || !SHA256.test(item.sha256)
  ) throw new PublicationStoreError("Publication artifact is invalid");
  return item as unknown as ManifestArtifactEntry;
}

function parseManifest(value: unknown, taskId: string, requirementId: string): PublicationManifest {
  const item = object(value, "Publication manifest");
  if (
    item.task_id !== taskId || item.requirement_id !== requirementId ||
    typeof item.dataset_family !== "string" || typeof item.row_granularity !== "string" ||
    typeof item.schema_ref !== "string" || !Number.isInteger(item.row_count) ||
    Number(item.row_count) < 0 || typeof item.sha256 !== "string" ||
    !SHA256.test(item.sha256) || !Array.isArray(item.artifacts)
  ) throw new PublicationStoreError("Publication manifest is invalid");
  return {
    ...item,
    task_id: taskId,
    requirement_id: requirementId,
    dataset_family: item.dataset_family,
    row_granularity: item.row_granularity,
    schema_ref: item.schema_ref,
    row_count: Number(item.row_count),
    sha256: item.sha256,
    artifacts: item.artifacts.map(parseArtifact),
  };
}

function parsePublication(value: unknown): DatasetPublication {
  const item = object(value, "Publication receipt");
  if (
    item.schema_version !== "1.1" || typeof item.publication_id !== "string" ||
    !SAFE_ID.test(item.publication_id) ||
    typeof item.manifest_ref !== "string" || typeof item.validation_result_ref !== "string" ||
    typeof item.published_at !== "string" || typeof item.manifest_sha256 !== "string" ||
    !SHA256.test(item.manifest_sha256) ||
    (item.supersedes_publication_id !== null &&
      (typeof item.supersedes_publication_id !== "string" || !SAFE_ID.test(item.supersedes_publication_id)))
  ) throw new PublicationStoreError("Publication receipt is invalid");
  return item as unknown as DatasetPublication;
}

async function json(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function directories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function verifiedFile(root: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new PublicationStoreError("Publication artifact path is invalid");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new PublicationStoreError("Publication artifact path is invalid");
  }
  let actualRoot: string;
  let actualFile: string;
  try {
    [actualRoot, actualFile] = await Promise.all([
      realpath(root),
      realpath(path.resolve(root, ...segments)),
    ]);
  } catch (error) {
    throw new PublicationStoreError(`Registered artifact is missing: ${String(error)}`);
  }
  const relative = path.relative(actualRoot, actualFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PublicationStoreError("Publication artifact path escapes its publication");
  }
  return actualFile;
}

export class PublicationStore {
  constructor(private readonly tasksRoot: string) {}

  private async scan(): Promise<PublicationRecord[]> {
    const records: PublicationRecord[] = [];
    for (const taskId of await directories(this.tasksRoot)) {
      const taskRoot = path.join(this.tasksRoot, taskId);
      for (const runId of await directories(path.join(taskRoot, "dataset_runs"))) {
        for (const requirementId of await directories(path.join(taskRoot, "dataset_runs", runId))) {
          const executionRoot = path.join(taskRoot, "dataset_runs", runId, requirementId);
          for (const publicationId of await directories(path.join(executionRoot, "publish"))) {
            const publicationDir = path.join(executionRoot, "publish", publicationId);
            try {
              const manifestPath = path.join(publicationDir, "dataset_manifest.json");
              const [manifestValue, publicationValue, details] = await Promise.all([
                json(manifestPath),
                json(path.join(publicationDir, "publication.json")),
                stat(manifestPath),
              ]);
              const receipt = parsePublication(publicationValue);
              // Writers name the publish directory without the `pub_` prefix
              // while the receipt carries the canonical prefixed id; accept
              // both spellings and index the record by the receipt id that
              // API callers query with.
              if (receipt.publication_id !== publicationId && receipt.publication_id !== `pub_${publicationId}`) {
                throw new PublicationStoreError("Publication receipt is invalid");
              }
              const { sha256 } = await sha256FileStreamWithSize(manifestPath);
              if (sha256 !== receipt.manifest_sha256) {
                throw new PublicationStoreError("Publication manifest receipt mismatch");
              }
              records.push({
                taskId,
                runId,
                requirementId,
                publicationId: receipt.publication_id,
                publicationDir,
                manifestRef: `dataset_runs/${runId}/${requirementId}/publish/${publicationId}/dataset_manifest.json`,
                manifest: parseManifest(manifestValue, taskId, requirementId),
                publication: receipt,
                modifiedAt: details.mtimeMs,
              });
            } catch (error) {
              if (error instanceof PublicationStoreError) throw error;
              throw new PublicationStoreError(
                `Publication ${publicationId} is corrupt: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
      }
    }
    return records.sort((left, right) => right.modifiedAt - left.modifiedAt);
  }

  async list(limit = 50): Promise<{ items: Record<string, unknown>[]; next_cursor: null }> {
    return {
      items: (await this.scan()).slice(0, limit).map((record) => ({
        publication_id: record.publicationId,
        requirement_id: record.requirementId,
        run_id: record.runId,
        task_id: record.taskId,
        dataset_family: record.manifest.dataset_family,
        row_granularity: record.manifest.row_granularity,
        schema_ref: record.manifest.schema_ref,
        row_count: record.manifest.row_count,
        manifest_ref: record.manifestRef,
        manifest_sha256: record.publication.manifest_sha256,
        published_at: record.publication.published_at,
      })),
      next_cursor: null,
    };
  }

  private async find(publicationId: string, taskId?: string): Promise<PublicationRecord | null> {
    if (!SAFE_ID.test(publicationId) || (taskId !== undefined && !SAFE_ID.test(taskId))) return null;
    return (await this.scan()).find((record) =>
      record.publicationId === publicationId && (taskId === undefined || record.taskId === taskId),
    ) ?? null;
  }

  async detail(publicationId: string, taskId?: string): Promise<Record<string, unknown> | null> {
    const record = await this.find(publicationId, taskId);
    return record === null ? null : {
      publication_id: record.publicationId,
      requirement_id: record.requirementId,
      run_id: record.runId,
      task_id: record.taskId,
      manifest_ref: record.manifestRef,
      manifest: record.manifest,
      publication: record.publication,
      artifacts: record.manifest.artifacts,
    };
  }

  async artifact(publicationId: string, artifactId: string, taskId?: string): Promise<StreamedArtifact | null> {
    if (!SAFE_ID.test(artifactId)) return null;
    const record = await this.find(publicationId, taskId);
    if (record === null) return null;
    const item = artifactId === "dataset_manifest"
      ? null
      : record.manifest.artifacts.find((candidate) => candidate.artifact_id === artifactId);
    if (artifactId !== "dataset_manifest" && item === undefined) return null;
    const relativePath = item?.relative_path ?? "dataset_manifest.json";
    const file = await verifiedFile(record.publicationDir, relativePath);
    const { sha256, bytes } = await sha256FileStreamWithSize(file);
    const expectedHash = item?.sha256 ?? record.publication.manifest_sha256;
    const expectedSize = item?.size_bytes;
    if (sha256 !== expectedHash || (expectedSize !== undefined && bytes !== expectedSize)) {
      throw new PublicationStoreError("Artifact integrity check failed");
    }
    return {
      stream: createReadStream(file),
      sizeBytes: bytes,
      mediaType: item?.media_type ?? "application/json",
      name: path.posix.basename(relativePath),
    };
  }
}
