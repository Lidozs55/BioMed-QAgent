/**
 * ``BioMedSessionConfig`` validation performed at session-creation entry:
 * safe identifiers for task/run, existing absolute directories for every
 * path-bearing field.
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import { BioMedAgentError, type BioMedSessionConfig } from "../contracts.js";
import { requireSafeId as validateSafeId } from "../ids.js";

function requireSafeId(name: string, value: string): void {
  validateSafeId(name, value, {
    message: `${name} must be a safe non-empty identifier`,
    errorFactory: (message) => new BioMedAgentError("INVALID_SESSION_CONFIG", message),
  });
}

async function requireDirectory(name: string, value: string): Promise<string> {
  if (!path.isAbsolute(value)) {
    throw new BioMedAgentError(
      "INVALID_SESSION_CONFIG",
      `${name} must be an absolute directory`,
    );
  }
  try {
    if (!(await stat(value)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new BioMedAgentError(
      "INVALID_SESSION_CONFIG",
      `${name} must reference an existing directory`,
      { cause: error },
    );
  }
  return path.resolve(value);
}

export async function validateSessionConfig(
  config: BioMedSessionConfig,
): Promise<BioMedSessionConfig> {
  requireSafeId("taskId", config.taskId);
  requireSafeId("runId", config.runId);
  const cwd = await requireDirectory("cwd", config.cwd);
  const resourceRoots = await Promise.all(
    (config.resourceRoots ?? []).map((root) => requireDirectory("resource root", root)),
  );
  const skillRoots = await Promise.all(
    (config.skillRoots ?? []).map((root) => requireDirectory("skill root", root)),
  );
  const codeReadRoots = await Promise.all(
    (config.codeReadRoots ?? []).map((root) => requireDirectory("code read root", root)),
  );
  const sessionDir = config.sessionDir === undefined
    ? undefined
    : await requireDirectory("session directory", config.sessionDir);
  return { ...config, cwd, resourceRoots, skillRoots, codeReadRoots, sessionDir };
}
