/**
 * Read-only text access inside an agent task workspace.
 *
 * Backs the sidebar data-visualization panel: chart CSVs written by the
 * ``extract_chart_data_vlm`` tool (``parsed/chart_data/*.csv``) are fetched
 * by the frontend through ``GET /api/v1/tasks/:id/file?path=<relative>``.
 * Only small text files (csv/json/txt/md) are served; path traversal,
 * absolute paths and oversized files are rejected.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Upper bound for served files; chart CSVs stay far below this. */
export const MAX_TASK_FILE_BYTES = 4 * 1024 * 1024;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

export type TaskFileReadResult =
  | { ok: true; content: string; mediaType: string }
  | { ok: false; code: "invalid_path" | "not_found" | "too_large" };

/**
 * Resolve ``relativePath`` inside ``workspacePath`` and read it as UTF-8
 * text. Expected failure modes return a coded result (mapped by the HTTP
 * layer to 400/404/413) instead of throwing; unexpected FS errors surface
 * as ``not_found`` to avoid leaking paths over the wire.
 */
export async function readTaskTextFile(
  workspacePath: string,
  relativePath: string,
): Promise<TaskFileReadResult> {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath)
  ) {
    return { ok: false, code: "invalid_path" };
  }
  const normalized = path.normalize(relativePath);
  if (normalized.split(path.sep).includes("..")) {
    return { ok: false, code: "invalid_path" };
  }
  const mediaType = MEDIA_TYPES[path.extname(normalized).toLowerCase()];
  if (mediaType === undefined) {
    return { ok: false, code: "invalid_path" };
  }
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(root + path.sep)) {
    return { ok: false, code: "invalid_path" };
  }
  let size: number;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return { ok: false, code: "not_found" };
    size = info.size;
  } catch {
    return { ok: false, code: "not_found" };
  }
  if (size > MAX_TASK_FILE_BYTES) {
    return { ok: false, code: "too_large" };
  }
  try {
    return { ok: true, content: await readFile(resolved, "utf8"), mediaType };
  } catch {
    return { ok: false, code: "not_found" };
  }
}
