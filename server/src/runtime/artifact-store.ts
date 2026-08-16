import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { ArtifactRecord } from "@biomed/contracts";
import { parseManifestArtifactEntry } from "../dataset/contracts/manifest.js";
import {
  packageDigest,
  type ManifestArtifactEntry,
} from "../dataset/publish/manifest.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type ManifestArtifact = ManifestArtifactEntry;

interface LoadedManifest {
  publicationDir: string;
  manifestPath: string;
  manifestBytes: Buffer;
  artifacts: ManifestArtifact[];
}

interface PublicationLocation {
  directory: string;
  manifestRef: string;
  /** ``"1.1"`` records carry the file-byte receipt; ``"1.0"`` are legacy. */
  schemaVersion: "1.0" | "1.1";
  /** P7 trust anchor: SHA-256 of the dataset_manifest.json file bytes (1.1 only). */
  manifestSha256: string | null;
}

export class ArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactIntegrityError";
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactIntegrityError(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function parseArtifact(value: unknown): ManifestArtifact {
  let entry: ManifestArtifact;
  try {
    entry = parseManifestArtifactEntry(value);
  } catch (caught) {
    throw new ArtifactIntegrityError(`Build manifest artifact is invalid: ${String(caught)}`);
  }
  if (!SAFE_ID.test(entry.artifact_id) || !SHA256.test(entry.sha256)) {
    throw new ArtifactIntegrityError("Build manifest artifact is invalid");
  }
  return entry;
}

async function verifiedPath(buildDir: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new ArtifactIntegrityError("Build manifest path is invalid");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ArtifactIntegrityError("Build manifest path is invalid");
  }
  const resolved = path.resolve(buildDir, ...segments);
  const relative = path.relative(path.resolve(buildDir), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ArtifactIntegrityError("Build manifest path is invalid");
  }
  let realRoot: string;
  let realFile: string;
  try {
    [realRoot, realFile] = await Promise.all([realpath(buildDir), realpath(resolved)]);
  } catch (error) {
    throw new ArtifactIntegrityError(`Registered artifact is missing: ${String(error)}`);
  }
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new ArtifactIntegrityError("Build manifest path escapes its publication");
  }
  return realFile;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadLatestManifest(taskRoot: string): Promise<LoadedManifest | null> {
  const buildsRoot = path.join(taskRoot, "datasets_build");
  let entries;
  try {
    entries = await readdir(buildsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let newest: {
    mtimeMs: number;
    publicationDir: string;
    manifestPath: string;
    manifestRef: string;
    schemaVersion: "1.0" | "1.1";
    manifestSha256: string | null;
  } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    const buildDir = path.join(buildsRoot, entry.name);
    try {
      const publication = await latestPublication(buildDir);
      if (publication === null) continue;
      const manifestPath = path.join(publication.directory, "dataset_manifest.json");
      const details = await stat(manifestPath);
      if (newest === undefined || details.mtimeMs > newest.mtimeMs) {
        newest = {
          mtimeMs: details.mtimeMs,
          publicationDir: publication.directory,
          manifestPath,
          manifestRef: publication.manifestRef,
          schemaVersion: publication.schemaVersion,
          manifestSha256: publication.manifestSha256,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (newest === undefined) return null;
  const manifestBytes = await readFile(await verifiedPath(
    newest.publicationDir,
    path.basename(newest.manifestPath),
  ));
  if (newest.schemaVersion === "1.1" && newest.manifestSha256 !== null) {
    // P7 trust anchor (1.1): the ``publication.json`` receipt records the
    // SHA-256 of the manifest FILE BYTES as published. Any edit to the
    // manifest file — including its top-level metadata (row_count,
    // validation_summary, …) which ``packageDigest`` does not cover —
    // changes the bytes and is rejected here, before the package-digest
    // check below (ADR-026 §3).
    if (sha256Hex(manifestBytes) !== newest.manifestSha256) {
      throw new ArtifactIntegrityError("Build manifest file hash is invalid");
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new ArtifactIntegrityError(`Build manifest is invalid: ${String(error)}`);
  }
  const manifest = record(parsed, "Build manifest");
  const taskId = path.basename(taskRoot);
  const buildId = path.basename(path.dirname(path.dirname(newest.publicationDir)));
  if (
    manifest.task_id !== taskId ||
    manifest.build_id !== buildId ||
    typeof manifest.manifest_id !== "string" ||
    manifest.manifest_id !== newest.manifestRef ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new ArtifactIntegrityError("Build manifest artifacts are invalid");
  }
  // P7 trust anchor: the reader recomputes the package digest from the
  // manifest's own artifact entries and requires it to match BOTH the
  // recorded `sha256` and the `manifest_id` prefix. A tamper that rewrites
  // an artifact entry without correctly recomputing the whole package
  // digest is therefore detected — the manifest cannot silently "forget"
  // that its contents changed (ADR-026 §3).
  const artifacts = manifest.artifacts.map(parseArtifact);
  const digest = packageDigest(artifacts);
  if (
    typeof manifest.sha256 !== "string" ||
    !SHA256.test(manifest.sha256) ||
    manifest.sha256 !== digest ||
    manifest.manifest_id !== `manifest_${digest.slice(0, 16)}`
  ) {
    throw new ArtifactIntegrityError("Build manifest package digest is invalid");
  }
  return {
    publicationDir: newest.publicationDir,
    manifestPath: newest.manifestPath,
    manifestBytes,
    artifacts,
  };
}

async function latestPublication(buildDir: string): Promise<PublicationLocation | null> {
  const publishRoot = path.join(buildDir, "publish");
  let entries;
  try {
    entries = await readdir(publishRoot, { withFileTypes: true });
  } catch (error) {
    // ``publish/`` itself absent → nothing was ever published → null.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let newest: {
    publishedAt: string;
    directory: string;
    manifestRef: string;
    schemaVersion: "1.0" | "1.1";
    manifestSha256: string | null;
  } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(publishRoot, entry.name);
    let raw: unknown;
    try {
      // A directory without ``publication.json`` is not a publication; a
      // publication.json that EXISTS but is corrupt is an integrity error
      // (round-3 audit: corruption must surface as 409, never as a silent
      // "no publication").
      raw = JSON.parse(await readFile(
        await verifiedPath(directory, "publication.json"),
        "utf8",
      )) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SyntaxError) {
        throw new ArtifactIntegrityError(
          `Dataset publication is corrupt: ${path.basename(directory)}/publication.json is not valid JSON`,
        );
      }
      throw error;
    }
    const publication = record(raw, "Dataset publication");
    const schemaVersion = publication.schema_version === "1.1"
      ? "1.1" as const
      : publication.schema_version === "1.0"
        ? "1.0" as const
        : null;
    if (schemaVersion === null) {
      throw new ArtifactIntegrityError(
        "Dataset publication schema_version must be \"1.0\" or \"1.1\"",
      );
    }
    let manifestSha256: string | null = null;
    if (schemaVersion === "1.1") {
      // 1.1 without the receipt is corrupt (fail closed, round-3 audit).
      if (
        typeof publication.manifest_sha256 !== "string" ||
        !SHA256.test(publication.manifest_sha256)
      ) {
        throw new ArtifactIntegrityError(
          "Dataset publication 1.1 is missing its manifest file receipt",
        );
      }
      manifestSha256 = publication.manifest_sha256;
    } else if (publication.manifest_sha256 !== undefined) {
      // A legacy 1.0 record claiming a P7 receipt is mislabeled.
      throw new ArtifactIntegrityError(
        "Dataset publication 1.0 must not carry manifest_sha256",
      );
    }
    if (
      typeof publication.publication_id === "string" &&
      SAFE_ID.test(publication.publication_id) &&
      typeof publication.manifest_ref === "string" &&
      publication.manifest_ref !== ""
    ) {
      const publishedAt = typeof publication.published_at === "string"
        ? publication.published_at
        : entry.name;
      if (newest === null || publishedAt > newest.publishedAt) {
        newest = {
          publishedAt,
          directory,
          manifestRef: publication.manifest_ref,
          schemaVersion,
          manifestSha256,
        };
      }
    }
  }
  return newest === null
    ? null
    : {
        directory: newest.directory,
        manifestRef: newest.manifestRef,
        schemaVersion: newest.schemaVersion,
        manifestSha256: newest.manifestSha256,
      };
}

async function readVerifiedArtifact(
  loaded: LoadedManifest,
  artifact: ManifestArtifact,
): Promise<Buffer> {
  const bytes = await readFile(await verifiedPath(
    loaded.publicationDir,
    artifact.relative_path,
  ));
  if (bytes.length !== artifact.size_bytes || sha256Hex(bytes) !== artifact.sha256) {
    throw new ArtifactIntegrityError("Artifact integrity check failed");
  }
  return bytes;
}

export async function listTaskArtifacts(taskRoot: string): Promise<ArtifactRecord[]> {
  const loaded = await loadLatestManifest(taskRoot);
  if (loaded === null) return [];
  const artifacts: ArtifactRecord[] = [{
    artifact_id: "dataset_manifest",
    name: "dataset_manifest.json",
    role: "schema",
    size: loaded.manifestBytes.length,
    sha256: sha256Hex(loaded.manifestBytes),
    media_type: "application/json",
  }];
  for (const artifact of loaded.artifacts) {
    await readVerifiedArtifact(loaded, artifact);
    artifacts.push({
      artifact_id: artifact.artifact_id,
      name: path.posix.basename(artifact.relative_path),
      role: artifact.role,
      size: artifact.size_bytes,
      sha256: artifact.sha256,
      media_type: artifact.media_type,
    });
  }
  return artifacts;
}

export async function getTaskArtifact(
  taskRoot: string,
  artifactId: string,
): Promise<{ bytes: Buffer; mediaType: string; name: string } | null> {
  if (!SAFE_ID.test(artifactId)) return null;
  const loaded = await loadLatestManifest(taskRoot);
  if (loaded === null) return null;
  if (artifactId === "dataset_manifest") {
    return {
      bytes: loaded.manifestBytes,
      mediaType: "application/json",
      name: "dataset_manifest.json",
    };
  }
  const artifact = loaded.artifacts.find((candidate) => candidate.artifact_id === artifactId);
  if (artifact === undefined) return null;
  return {
    bytes: await readVerifiedArtifact(loaded, artifact),
    mediaType: artifact.media_type,
    name: path.posix.basename(artifact.relative_path),
  };
}
