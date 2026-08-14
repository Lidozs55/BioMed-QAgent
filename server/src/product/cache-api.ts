import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

interface CacheDatabase {
  call<T>(op: string, args: Record<string, unknown>): Promise<T>;
}

interface CacheManifest extends Record<string, unknown> {
  dataset_id: string;
  source_namespace: string;
  row_count: number;
  created_at: string;
  keywords?: unknown;
}

export interface CacheArtifactDownload {
  bytes: Buffer;
  mediaType: string;
  name: string;
}

function manifest(value: unknown): CacheManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cache manifest is invalid");
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.dataset_id !== "string" || !SAFE_SEGMENT.test(item.dataset_id) ||
    typeof item.source_namespace !== "string" || !SAFE_SEGMENT.test(item.source_namespace) ||
    !Number.isInteger(item.row_count) || Number(item.row_count) < 0 ||
    typeof item.created_at !== "string"
  ) {
    throw new Error("Cache manifest is invalid");
  }
  return {
    ...item,
    dataset_id: item.dataset_id,
    source_namespace: item.source_namespace,
    row_count: Number(item.row_count),
    created_at: item.created_at,
  };
}

function summary(item: CacheManifest): Record<string, unknown> {
  return {
    dataset_id: item.dataset_id,
    namespace: item.source_namespace,
    dataset_family: "gene_expression",
    schema_ref: "gene_expression.long.legacy.v1",
    row_count: item.row_count,
    published_at: item.created_at,
    keywords: Array.isArray(item.keywords)
      ? item.keywords.filter((value): value is string => typeof value === "string")
      : [],
    manifest_ref: `cache/records/${item.source_namespace}/${item.dataset_id}/manifest.json`,
  };
}

function artifacts(): Record<string, unknown>[] {
  return [
    {
      artifact_id: "main_data",
      role: "primary_dataset",
      relative_path: "main_data.csv",
      media_type: "text/csv",
    },
    {
      artifact_id: "manifest",
      role: "schema",
      relative_path: "manifest.json",
      media_type: "application/json",
    },
  ];
}

async function guardedRecordDir(cacheDir: string, namespace: string, datasetId: string): Promise<string> {
  if (!SAFE_SEGMENT.test(namespace) || !SAFE_SEGMENT.test(datasetId)) {
    throw new Error("Invalid cache identity");
  }
  const recordsRoot = path.join(cacheDir, "records");
  const candidate = path.join(recordsRoot, namespace, datasetId);
  const [actualRoot, actualCandidate] = await Promise.all([realpath(recordsRoot), realpath(candidate)]);
  const relative = path.relative(actualRoot, actualCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Cache record escapes cache root");
  }
  return actualCandidate;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; bytes: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, file.bytes);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + file.bytes.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

export class CacheApi {
  constructor(
    private readonly cacheDir: string,
    private readonly database: CacheDatabase,
  ) {}

  async list(namespace?: string, keyword?: string, limit = 50): Promise<{ items: Record<string, unknown>[] }> {
    const values = await this.database.call<unknown[]>("cache.list", {
      ...(namespace === undefined ? {} : { source_namespace: namespace }),
      limit: Math.min(Math.max(limit, 1), 200),
    });
    const needle = keyword?.trim().toLowerCase() ?? "";
    return {
      items: values.map(manifest).filter((item) => (
        needle === "" || JSON.stringify(item).toLowerCase().includes(needle)
      )).map(summary),
    };
  }

  private async resolve(datasetId: string, namespace?: string): Promise<CacheManifest | null> {
    if (!SAFE_SEGMENT.test(datasetId)) return null;
    if (namespace !== undefined) {
      if (!SAFE_SEGMENT.test(namespace)) return null;
      const value = await this.database.call<unknown>("cache.describe", {
        source_namespace: namespace,
        dataset_id: datasetId,
      });
      return value === null ? null : manifest(value);
    }
    const values = await this.database.call<unknown[]>("cache.list", { limit: 10_000 });
    return values.map(manifest).find((item) => item.dataset_id === datasetId) ?? null;
  }

  async detail(datasetId: string, namespace?: string): Promise<Record<string, unknown> | null> {
    const item = await this.resolve(datasetId, namespace);
    if (item === null) return null;
    await guardedRecordDir(this.cacheDir, item.source_namespace, item.dataset_id);
    return { ...summary(item), artifacts: artifacts() };
  }

  async artifact(
    datasetId: string,
    namespace: string | undefined,
    artifactId: string,
  ): Promise<CacheArtifactDownload | null> {
    const names = artifactId === "main_data"
      ? { file: "main_data.csv", mediaType: "text/csv" }
      : artifactId === "manifest"
        ? { file: "manifest.json", mediaType: "application/json" }
        : null;
    if (names === null) return null;
    const item = await this.resolve(datasetId, namespace);
    if (item === null) return null;
    const directory = await guardedRecordDir(
      this.cacheDir,
      item.source_namespace,
      item.dataset_id,
    );
    const file = path.join(directory, names.file);
    await stat(file);
    return { bytes: await readFile(file), mediaType: names.mediaType, name: names.file };
  }

  async exportZip(): Promise<Buffer> {
    const values = await this.database.call<unknown[]>("cache.list", { limit: 10_000 });
    const files: Array<{ name: string; bytes: Buffer }> = [];
    const index: CacheManifest[] = [];
    for (const value of values) {
      const item = manifest(value);
      const directory = await guardedRecordDir(this.cacheDir, item.source_namespace, item.dataset_id);
      const prefix = `cache_export/${item.source_namespace}/${item.dataset_id}`;
      for (const name of ["main_data.csv", "manifest.json"]) {
        try {
          files.push({ name: `${prefix}/${name}`, bytes: await readFile(path.join(directory, name)) });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      index.push(item);
    }
    files.push({
      name: "cache_export/index.json",
      bytes: Buffer.from(JSON.stringify({ datasets: index }, null, 2) + "\n", "utf8"),
    });
    return zip(files);
  }
}
