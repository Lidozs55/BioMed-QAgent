import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { WorkspacePolicyError } from "./types.js";

/**
 * Legacy workspace migration (plan §38–§41).
 *
 * Old tasks keep their agent-owned files under
 * ``data/output/tasks/<taskId>/staging/agent/**``; the new home is
 * ``data/workspaces/<taskId>/**`` (the ``staging/agent`` layer is dropped).
 *
 * Decision (plan §39):
 *
 * ```text
 * if new workspace exists:
 *     use new workspace
 * else if legacy staging/agent exists:
 *     create new workspace
 *     migrate files
 *     verify copy
 *     mark migrated        (state/workspace.json)
 * else:
 *     create empty workspace
 * ```
 *
 * The copy is verified before the marker is written; the legacy directory is
 * intentionally left in place (first version keeps a reversible migration).
 */

export interface WorkspaceStateMarker {
  version: 2;
  workspace: string;
  legacy_workspace_migrated: boolean;
  migrated_at?: string;
}

export interface LegacyWorkspaceMigrationOptions {
  taskId: string;
  workspaceRoot: string;
  taskOutputRoot: string;
  now?: () => Date;
}

export function markerPathFor(taskOutputRoot: string): string {
  return path.join(taskOutputRoot, "state", "workspace.json");
}

export async function readWorkspaceStateMarker(
  taskOutputRoot: string,
): Promise<WorkspaceStateMarker | null> {
  try {
    const parsed = JSON.parse(
      await readFile(markerPathFor(taskOutputRoot), "utf8"),
    ) as WorkspaceStateMarker;
    if (parsed.version !== 2 || typeof parsed.workspace !== "string") return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Copy the legacy ``staging/agent`` tree into the new workspace root. */
async function copyLegacyTree(legacyRoot: string, workspaceRoot: string): Promise<number> {
  let copiedFiles = 0;
  async function visit(source: string, relative: string): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(workspaceRoot, ...childRelative.split("/"));
      if (entry.isSymbolicLink()) {
        // Symlinks are not migrated; the agent may recreate them in its own
        // workspace where the permission system classifies their targets.
        continue;
      }
      if (entry.isDirectory()) {
        await mkdir(targetPath, { recursive: true });
        await visit(sourcePath, childRelative);
        continue;
      }
      if (entry.isFile()) {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, await readFile(sourcePath), { flag: "wx" });
        copiedFiles += 1;
      }
    }
  }
  await visit(legacyRoot, "");
  return copiedFiles;
}

/** Recursively verify that every legacy file exists with identical bytes. */
async function verifyCopiedTree(legacyRoot: string, workspaceRoot: string): Promise<number> {
  let verifiedFiles = 0;
  async function visit(source: string, relative: string): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(workspaceRoot, ...childRelative.split("/"));
      if (entry.isDirectory()) {
        await visit(sourcePath, childRelative);
        continue;
      }
      if (entry.isFile()) {
        const [left, right] = await Promise.all([readFile(sourcePath), readFile(targetPath)]);
        if (!left.equals(right)) {
          throw new WorkspacePolicyError(
            "PRECONDITION_FAILED",
            `Legacy workspace migration verification failed for ${childRelative}`,
          );
        }
        verifiedFiles += 1;
      }
    }
  }
  await visit(legacyRoot, "");
  return verifiedFiles;
}

async function writeMarker(
  taskOutputRoot: string,
  workspaceRoot: string,
  migrated: boolean,
  now?: () => Date,
): Promise<void> {
  const marker: WorkspaceStateMarker = {
    version: 2,
    workspace: workspaceRoot,
    legacy_workspace_migrated: migrated,
    ...(migrated ? { migrated_at: (now ?? (() => new Date()))().toISOString() } : {}),
  };
  const target = markerPathFor(taskOutputRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

/**
 * Migrate legacy ``staging/agent`` content into a fresh workspace root.
 * Idempotent: a marker file means the migration already happened.
 */
export async function migrateLegacyWorkspace(
  options: LegacyWorkspaceMigrationOptions,
): Promise<{ migrated: boolean; copiedFiles: number }> {
  const { taskId, workspaceRoot, taskOutputRoot } = options;
  void taskId;
  const marker = await readWorkspaceStateMarker(taskOutputRoot);
  if (marker !== null) {
    const canonicalMarker = process.platform === "win32"
      ? marker.workspace.toLowerCase()
      : marker.workspace;
    const canonicalWorkspace = process.platform === "win32"
      ? workspaceRoot.toLowerCase()
      : workspaceRoot;
    if (canonicalMarker === canonicalWorkspace) {
      return { migrated: marker.legacy_workspace_migrated, copiedFiles: 0 };
    }
  }
  const legacyRoot = path.join(taskOutputRoot, "staging", "agent");
  if (!(await isDirectory(legacyRoot))) {
    await writeMarker(taskOutputRoot, workspaceRoot, false, options.now);
    return { migrated: false, copiedFiles: 0 };
  }
  await mkdir(workspaceRoot, { recursive: true });
  // Refuse to mix a pre-existing workspace with a legacy tree.
  const workspaceEntries = await readdir(workspaceRoot);
  if (workspaceEntries.length > 0) {
    await writeMarker(taskOutputRoot, workspaceRoot, false, options.now);
    return { migrated: false, copiedFiles: 0 };
  }
  const copiedFiles = await copyLegacyTree(legacyRoot, workspaceRoot);
  if (copiedFiles > 0) {
    const verifiedFiles = await verifyCopiedTree(legacyRoot, workspaceRoot);
    if (verifiedFiles !== copiedFiles) {
      throw new WorkspacePolicyError(
        "PRECONDITION_FAILED",
        "Legacy workspace migration verification mismatch",
      );
    }
  }
  await writeMarker(taskOutputRoot, workspaceRoot, true, options.now);
  return { migrated: true, copiedFiles };
}
