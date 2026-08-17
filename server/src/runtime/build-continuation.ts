import type { DatasetBuildSpec } from "@biomed/contracts";

import path from "node:path";

import { readJsonFileOrNull, writeJsonAtomic } from "../persistence/atomic-json.js";
import { requireSafeId } from "./safe-id.js";

/**
 * Durable record of a dataset-build invocation, persisted by the
 * ``execute_dataset_build`` tool before it hands the build to the TS Core.
 *
 * On a process restart the deterministic continuation never asks the model
 * to "continue the task" from a synthetic prompt: the runtime reads this
 * record, rebuilds a tool workspace bound to the ORIGINAL run, replays the
 * same tool call (original ``tool_call_id``) and lets the executor resume
 * from its checkpointed state. The record lives under
 * ``state/hil/continuations/<build_id>.json`` inside the task root.
 */
export interface SuspendedBuildContinuation {
  schema_version: 1;
  build_id: string;
  task_id: string;
  run_id: string;
  pi_session_id: string;
  tool_call_id: string;
  spec: DatasetBuildSpec;
  source_files: Record<string, string>;
  mapping_files: Record<string, string>;
  metadata_files: Record<string, string>;
  created_at: string;
}

/** ``<taskRoot>/state/hil/continuations/<buildId>.json``. */
export function continuationPath(
  taskRoot: string,
  buildId: string,
): string {
  requireSafeId(buildId, "build_id");
  return path.join(taskRoot, "state", "hil", "continuations", `${buildId}.json`);
}

/** Atomic write (tmp + rename) so a crash never leaves a partial record. */
export async function saveBuildContinuation(
  taskRoot: string,
  continuation: SuspendedBuildContinuation,
): Promise<void> {
  await writeJsonAtomic(continuationPath(taskRoot, continuation.build_id), continuation);
}

function parseContinuation(value: unknown): SuspendedBuildContinuation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) return null;
  for (const name of ["build_id", "task_id", "run_id", "pi_session_id", "tool_call_id", "created_at"] as const) {
    if (typeof record[name] !== "string" || record[name].trim() === "") return null;
  }
  for (const name of ["spec", "source_files", "mapping_files", "metadata_files"] as const) {
    if (record[name] === null || typeof record[name] !== "object" || Array.isArray(record[name])) {
      return null;
    }
  }
  return record as unknown as SuspendedBuildContinuation;
}

export async function readBuildContinuation(
  taskRoot: string,
  buildId: string,
): Promise<SuspendedBuildContinuation | null> {
  try {
    const value = await readJsonFileOrNull<unknown>(continuationPath(taskRoot, buildId));
    return value === null ? null : parseContinuation(value);
  } catch {
    return null;
  }
}