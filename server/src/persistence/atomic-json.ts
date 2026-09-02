/**
 * Atomic JSON file persistence for small settings/state files.
 * Unifies the temp-file → chmod → rename pattern that used to be duplicated
 * in ``model-settings.ts`` (``readJson``/``atomicWrite``) and
 * ``product-api.ts`` (``readPersonalization``/``writePersonalization``).
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

/** Temp files older than this are considered crashed-write leftovers. */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Best-effort sweep of stale ``<name>.<pid>.<uuid>.tmp`` leftovers: a process
 * dying between the temp write and the rename strands them forever otherwise
 * (observed piling up in ``data/settings/``). Fresh temps (< 1h) are left
 * alone — they may belong to a concurrent write that is still in flight.
 */
async function sweepStaleTempFiles(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
    .map(async (name) => {
      const candidate = path.join(directory, name);
      try {
        const stats = await stat(candidate);
        if (Date.now() - stats.mtimeMs > STALE_TEMP_MAX_AGE_MS) {
          await unlink(candidate);
        }
      } catch {
        // An unreadable or concurrently-removed temp file is not worth
        // failing the actual write over.
      }
    }));
}

/** Read and JSON.parse a file; returns undefined on any failure (missing/parse). */
export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read and JSON.parse a file; returns null when the file does not exist and
 * rethrows any other failure (parse errors surface as errors). Replaces the
 * identical ENOENT-handling read helpers that used to be duplicated in
 * ``runtime/task-repository.ts``, ``runtime/hil-store.ts`` and
 * ``runtime/execution-continuation.ts``.
 */
export async function readJsonFileOrNull<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Atomically write *value* as pretty JSON (temp file + rename, so readers
 * never observe a partial file). Pass ``private`` for credential files to
 * get a 0600 mode.
 */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: { private?: boolean } = {},
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await sweepStaleTempFiles(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temporary, "w", options.private ? 0o600 : 0o666);
  try {
    if (options.private) await chmod(temporary, 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  // 目录 fsync 只在 POSIX 上有意义；libuv 在 Windows 对目录句柄 sync() 返回
  // EPERM（2026-09-02 实证，semantic route fence 的 durable write 全量失败）。
  if (process.platform !== "win32") {
    const directoryHandle = await open(path.dirname(filePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}