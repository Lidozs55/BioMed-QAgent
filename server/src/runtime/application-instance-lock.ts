import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APPLICATION_INSTANCE_LOCK_DIRECTORY = "production-instance-v1.lock";
const OWNER_FILENAME = "owner.json";

interface ApplicationInstanceOwner {
  schema_version: "1.0";
  holder_pid: number;
  token: string;
  acquired_at: string;
}

export interface ApplicationInstanceLease {
  release(): Promise<void>;
}

export type ApplicationInstanceLockResult =
  | { status: "acquired"; lease: ApplicationInstanceLease }
  | { status: "already_running"; holderPid: number };

export interface ApplicationInstanceLockOptions {
  lockRoot?: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  initGraceMs?: number;
  retryIntervalMs?: number;
  takeoverTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

interface LockRootOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function validOwner(value: unknown): value is ApplicationInstanceOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Partial<ApplicationInstanceOwner>;
  return owner.schema_version === "1.0"
    && typeof owner.holder_pid === "number"
    && Number.isSafeInteger(owner.holder_pid)
    && owner.holder_pid > 0
    && typeof owner.token === "string"
    && owner.token.length > 0
    && typeof owner.acquired_at === "string";
}

async function readOwner(lockDir: string): Promise<ApplicationInstanceOwner | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(lockDir, OWNER_FILENAME), "utf8"));
    return validOwner(parsed) ? parsed : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function resolveApplicationInstanceLockRoot(options: LockRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();

  if (platform === "win32") {
    return path.join(environment.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local"), "BioMed-QAgent", "runtime");
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "BioMed-QAgent", "runtime");
  }
  if (environment.XDG_RUNTIME_DIR?.trim()) {
    return path.join(environment.XDG_RUNTIME_DIR, "biomed-qagent");
  }
  const stateRoot = environment.XDG_STATE_HOME?.trim() || path.join(homeDir, ".local", "state");
  return path.join(stateRoot, "biomed-qagent", "runtime");
}

async function waitForOwner(
  lockDir: string,
  initGraceMs: number,
  retryIntervalMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<ApplicationInstanceOwner | null> {
  const deadline = Date.now() + initGraceMs;
  let owner = await readOwner(lockDir);
  while (owner === null && Date.now() < deadline) {
    await sleep(retryIntervalMs);
    owner = await readOwner(lockDir);
  }
  return owner;
}

export async function acquireApplicationInstanceLock(
  options: ApplicationInstanceLockOptions = {},
): Promise<ApplicationInstanceLockResult> {
  const lockRoot = options.lockRoot ?? resolveApplicationInstanceLockRoot();
  const lockDir = path.join(lockRoot, APPLICATION_INSTANCE_LOCK_DIRECTORY);
  const ownerPath = path.join(lockDir, OWNER_FILENAME);
  const claimingPid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const initGraceMs = options.initGraceMs ?? 2_000;
  const retryIntervalMs = options.retryIntervalMs ?? 50;
  const takeoverTimeoutMs = options.takeoverTimeoutMs ?? 5_000;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const now = options.now ?? (() => new Date());
  const takeoverDeadline = Date.now() + takeoverTimeoutMs;

  await mkdir(lockRoot, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const token = randomUUID();
    try {
      await mkdir(lockDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await waitForOwner(lockDir, initGraceMs, retryIntervalMs, sleep);
      if (owner !== null && isAlive(owner.holder_pid)) {
        return { status: "already_running", holderPid: owner.holder_pid };
      }

      const graveyard = `${lockDir}.stale-${token}`;
      try {
        await rename(lockDir, graveyard);
      } catch (renameError) {
        const code = (renameError as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EPERM" || code === "EBUSY") {
          if (Date.now() >= takeoverDeadline) throw renameError;
          await sleep(retryIntervalMs);
          continue;
        }
        throw renameError;
      }
      await rm(graveyard, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }

    const owner: ApplicationInstanceOwner = {
      schema_version: "1.0",
      holder_pid: claimingPid,
      token,
      acquired_at: now().toISOString(),
    };
    try {
      await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    let released = false;
    return {
      status: "acquired",
      lease: {
        release: async (): Promise<void> => {
          if (released) return;
          const recorded = await readOwner(lockDir);
          if (recorded?.token === token) {
            await rm(lockDir, { recursive: true, force: true });
          }
          released = true;
        },
      },
    };
  }

  throw new Error(`could not acquire application instance lock at ${lockDir}`);
}
