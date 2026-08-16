import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { WorkspacePolicyError } from "./types.js";
import { taskWorkspacePath } from "./workspace-paths.js";

/**
 * Workspace lifecycle owner (plan §11, §12).
 *
 * - Task creation → ``ensure(taskId)`` creates ``data/workspaces/<taskId>``
 *   (and performs the legacy ``staging/agent`` migration when present).
 * - Task deletion → ``remove(taskId)`` deletes the workspace AFTER the run
 *   has been cancelled and the Pi session disposed (caller's obligation).
 * - Application restart → workspaces are durable; ``ensure(taskId)`` is
 *   idempotent and used during task restore.
 */
export interface WorkspaceManager {
  /** Resolve the workspace directory for a task (no side effects). */
  getPath(taskId: string): string;
  /** Create (or restore) the workspace directory and return its path. */
  ensure(taskId: string): Promise<string>;
  exists(taskId: string): Promise<boolean>;
  remove(taskId: string): Promise<void>;
}

export interface DiskWorkspaceManagerOptions {
  workspacesRoot: string;
  /** Optional migration hook run once when a new workspace is created. */
  migrateLegacy?: (taskId: string, workspaceRoot: string) => Promise<void>;
}

export class DiskWorkspaceManager implements WorkspaceManager {
  readonly workspacesRoot: string;
  private readonly migrateLegacy: (taskId: string, workspaceRoot: string) => Promise<void>;

  constructor(options: DiskWorkspaceManagerOptions) {
    this.workspacesRoot = path.resolve(options.workspacesRoot);
    this.migrateLegacy = options.migrateLegacy ?? (async () => undefined);
  }

  getPath(taskId: string): string {
    return taskWorkspacePath(this.workspacesRoot, taskId);
  }

  async ensure(taskId: string): Promise<string> {
    const target = this.getPath(taskId);
    let exists = false;
    try {
      if ((await stat(target)).isDirectory()) exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new WorkspacePolicyError("NOT_FOUND", "Task Workspace cannot be inspected", {
          cause: error,
        });
      }
    }
    if (exists) return target;
    await mkdir(target, { recursive: true });
    try {
      await this.migrateLegacy(taskId, target);
    } catch (error) {
      // A failed migration must not leave a half-populated workspace as a
      // "fresh" one; surface the error so task creation fails per plan §12.
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return target;
  }

  async exists(taskId: string): Promise<boolean> {
    try {
      return (await stat(this.getPath(taskId))).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async remove(taskId: string): Promise<void> {
    await rm(this.getPath(taskId), { recursive: true, force: true });
  }
}
