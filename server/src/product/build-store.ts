import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface BuildArtifact {
  artifact_id: string;
  role: string;
  relative_path: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
}

export interface BuildManifest extends Record<string, unknown> {
  task_id: string;
  build_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  row_count: number;
  sha256: string;
  artifacts: BuildArtifact[];
}

interface BuildRecord {
  taskId: string;
  buildId: string;
  buildDir: string;
  manifestPath: string;
  manifest: BuildManifest;
  modifiedAt: number;
  publication: Record<string, unknown> | null;
  buildResult: Record<string, unknown> | null;
}

export interface DownloadedArtifact {
  bytes: Buffer;
  mediaType: string;
  name: string;
}

export class BuildStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildStoreError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BuildStoreError(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function parseArtifact(value: unknown): BuildArtifact {
  const artifact = object(value, "Build artifact");
  if (
    typeof artifact.artifact_id !== "string" || !SAFE_ID.test(artifact.artifact_id) ||
    typeof artifact.role !== "string" || artifact.role === "" ||
    typeof artifact.relative_path !== "string" || artifact.relative_path === "" ||
    typeof artifact.media_type !== "string" || artifact.media_type === "" ||
    !Number.isInteger(artifact.size_bytes) || Number(artifact.size_bytes) < 0 ||
    typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)
  ) {
    throw new BuildStoreError("Build artifact is invalid");
  }
  return {
    artifact_id: artifact.artifact_id,
    role: artifact.role,
    relative_path: artifact.relative_path,
    media_type: artifact.media_type,
    size_bytes: Number(artifact.size_bytes),
    sha256: artifact.sha256,
  };
}

function parseManifest(value: unknown, taskId: string, buildId: string): BuildManifest {
  const manifest = object(value, "Build manifest");
  if (
    manifest.task_id !== taskId || manifest.build_id !== buildId ||
    typeof manifest.dataset_family !== "string" ||
    typeof manifest.row_granularity !== "string" ||
    typeof manifest.schema_ref !== "string" ||
    !Number.isInteger(manifest.row_count) || Number(manifest.row_count) < 0 ||
    typeof manifest.sha256 !== "string" || !SHA256.test(manifest.sha256) ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new BuildStoreError("Build manifest is invalid");
  }
  return {
    ...manifest,
    task_id: taskId,
    build_id: buildId,
    dataset_family: manifest.dataset_family,
    row_granularity: manifest.row_granularity,
    schema_ref: manifest.schema_ref,
    row_count: Number(manifest.row_count),
    sha256: manifest.sha256,
    artifacts: manifest.artifacts.map(parseArtifact),
  };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new BuildStoreError(`Invalid JSON at ${file}: ${String(error)}`);
  }
}

async function latestPublication(buildDir: string): Promise<Record<string, unknown> | null> {
  const root = path.join(buildDir, "publish");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    let newest: { key: string; value: Record<string, unknown> } | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const value = object(
          await readJson(path.join(root, entry.name, "publication.json")),
          "Publication",
        );
        const key = typeof value.published_at === "string" ? value.published_at : entry.name;
        if (newest === null || key > newest.key) newest = { key, value };
      } catch {
        // A partial publication is not visible on the product API.
      }
    }
    return newest?.value ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function durableBuildResult(
  taskRoot: string,
  buildId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const lines = (await readFile(path.join(taskRoot, "events.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const event = object(JSON.parse(lines[index]!) as unknown, "Task event");
      const payload = event.payload;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
      const result = (payload as Record<string, unknown>).build_result;
      if (result === null || typeof result !== "object" || Array.isArray(result)) continue;
      const record = result as Record<string, unknown>;
      if (record.build_id === buildId) return record;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof BuildStoreError) return null;
    throw error;
  }
}

async function verifiedFile(root: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new BuildStoreError("Build artifact path is invalid");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new BuildStoreError("Build artifact path is invalid");
  }
  const candidate = path.resolve(root, ...segments);
  let actualRoot: string;
  let actualFile: string;
  try {
    [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(candidate)]);
  } catch (error) {
    throw new BuildStoreError(`Registered artifact is missing: ${String(error)}`);
  }
  const relative = path.relative(actualRoot, actualFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BuildStoreError("Build artifact path escapes its build");
  }
  return actualFile;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class BuildStore {
  constructor(private readonly tasksRoot: string) {}

  private async scan(): Promise<BuildRecord[]> {
    let tasks;
    try {
      tasks = await readdir(this.tasksRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: BuildRecord[] = [];
    for (const task of tasks) {
      if (!task.isDirectory() || !SAFE_ID.test(task.name)) continue;
      const buildsRoot = path.join(this.tasksRoot, task.name, "datasets_build");
      let builds;
      try {
        builds = await readdir(buildsRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const build of builds) {
        if (!build.isDirectory() || !SAFE_ID.test(build.name)) continue;
        const buildDir = path.join(buildsRoot, build.name);
        const manifestPath = path.join(buildDir, "dataset_manifest.json");
        try {
          const [manifest, details, publication, buildResult] = await Promise.all([
            readJson(manifestPath).then((value) => parseManifest(value, task.name, build.name)),
            stat(manifestPath),
            latestPublication(buildDir),
            durableBuildResult(path.join(this.tasksRoot, task.name), build.name),
          ]);
          records.push({
            taskId: task.name,
            buildId: build.name,
            buildDir,
            manifestPath,
            manifest,
            modifiedAt: details.mtimeMs,
            publication,
            buildResult,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof BuildStoreError)) {
            throw error;
          }
        }
      }
    }
    return records.sort((left, right) => right.modifiedAt - left.modifiedAt);
  }

  async list(limit = 50): Promise<{ items: Record<string, unknown>[]; next_cursor: null }> {
    const records = await this.scan();
    return {
      items: records.slice(0, limit).map((record) => ({
        build_id: record.buildId,
        task_id: record.taskId,
        dataset_family: record.manifest.dataset_family,
        row_granularity: record.manifest.row_granularity,
        schema_ref: record.manifest.schema_ref,
        row_count: record.manifest.row_count,
        status: typeof record.buildResult?.status === "string"
          ? record.buildResult.status
          : record.publication === null ? "no_data" : "success",
        publication_id: record.publication?.publication_id ?? null,
        manifest_ref: `datasets_build/${record.buildId}/dataset_manifest.json`,
        manifest_sha256: record.manifest.sha256,
        published_at: record.publication?.published_at ?? null,
        build_result: record.buildResult,
      })),
      next_cursor: null,
    };
  }

  private async find(buildId: string, taskId?: string): Promise<BuildRecord | null> {
    if (!SAFE_ID.test(buildId) || (taskId !== undefined && !SAFE_ID.test(taskId))) return null;
    return (await this.scan()).find((record) => (
      record.buildId === buildId && (taskId === undefined || record.taskId === taskId)
    )) ?? null;
  }

  async detail(buildId: string, taskId?: string): Promise<Record<string, unknown> | null> {
    const record = await this.find(buildId, taskId);
    if (record === null) return null;
    return {
      build_id: record.buildId,
      task_id: record.taskId,
      manifest_ref: `datasets_build/${record.buildId}/dataset_manifest.json`,
      build_result: record.buildResult,
      manifest: record.manifest,
      publication: record.publication,
      artifacts: record.manifest.artifacts,
    };
  }

  async artifact(
    buildId: string,
    artifactId: string,
    taskId?: string,
  ): Promise<DownloadedArtifact | null> {
    if (!SAFE_ID.test(artifactId)) return null;
    const record = await this.find(buildId, taskId);
    if (record === null) return null;
    if (artifactId === "dataset_manifest") {
      const bytes = await readFile(record.manifestPath);
      return { bytes, mediaType: "application/json", name: "dataset_manifest.json" };
    }
    const artifact = record.manifest.artifacts.find((item) => item.artifact_id === artifactId);
    if (artifact === undefined) return null;
    const bytes = await readFile(await verifiedFile(record.buildDir, artifact.relative_path));
    if (bytes.length !== artifact.size_bytes || sha256(bytes) !== artifact.sha256) {
      throw new BuildStoreError("Artifact integrity check failed");
    }
    return {
      bytes,
      mediaType: artifact.media_type,
      name: path.posix.basename(artifact.relative_path),
    };
  }
}
