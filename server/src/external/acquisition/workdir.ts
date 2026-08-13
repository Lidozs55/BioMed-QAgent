/**
 * Task-local directory layout (Python ``app/tools/workdir.py`` parity).
 * Only the acquisition-relevant subset is ported; the Dataset Core owns
 * parsed/normalized/artifacts consumption.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function validateSafePathId(value: string, fieldName = "id"): string {
  if (!SAFE_ID.test(value)) {
    throw new TypeError(`${fieldName} must be a safe path identifier`);
  }
  return value;
}

/** Reject filenames that could escape the destination directory. */
export function assertSafeFilename(filename: string): string {
  if (!filename || path.basename(filename) !== filename || filename.includes("/") || filename.includes("\\")) {
    throw new TypeError("unsafe source filename");
  }
  return filename;
}

export interface TaskWorkDirs {
  root: string;
  sourceAssets: string;
  downloadTmp: string;
  parsed: string;
  normalized: string;
  staging: string;
  artifacts: string;
  state: string;
  logs: string;
  agentResults: string;
}

export function taskWorkDirs(root: string): TaskWorkDirs {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    sourceAssets: path.join(resolved, "source_assets"),
    downloadTmp: path.join(resolved, "download_tmp"),
    parsed: path.join(resolved, "parsed"),
    normalized: path.join(resolved, "normalized"),
    staging: path.join(resolved, "staging"),
    artifacts: path.join(resolved, "artifacts"),
    state: path.join(resolved, "state"),
    logs: path.join(resolved, "logs"),
    agentResults: path.join(resolved, "agent_results"),
  };
}

/** Ensure the download/source-asset directories exist. */
export async function ensureAcquisitionDirs(dirs: TaskWorkDirs): Promise<void> {
  await mkdir(dirs.downloadTmp, { recursive: true });
  await mkdir(dirs.sourceAssets, { recursive: true });
}

/** Content-addressed source asset location (Python source_assets/<asset>/<file>). */
export function sourceAssetPath(dirs: TaskWorkDirs, assetId: string, filename: string): string {
  return path.join(dirs.sourceAssets, validateSafePathId(assetId, "asset_id"), assertSafeFilename(filename));
}
