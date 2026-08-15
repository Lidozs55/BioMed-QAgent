/**
 * Atomic JSON file persistence for small settings/state files.
 * Unifies the temp-file → chmod → rename pattern that used to be duplicated
 * in ``model-settings.ts`` (``readJson``/``atomicWrite``) and
 * ``product-api.ts`` (``readPersonalization``/``writePersonalization``).
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Read and JSON.parse a file; returns undefined on any failure (missing/parse). */
export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
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
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: options.private ? 0o600 : undefined,
  });
  if (options.private) await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, filePath);
}