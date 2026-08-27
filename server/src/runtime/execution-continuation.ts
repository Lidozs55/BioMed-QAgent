import type { DatasetExecutionSpec } from "@biomed/contracts";

import path from "node:path";

import { readJsonFileOrNull, writeJsonAtomic } from "../persistence/atomic-json.js";
import { requireSafeId } from "./safe-id.js";

/**
 * Durable record of a dataset-execution invocation, persisted by the
 * ``execute_dataset_execution`` tool before it hands execution to the TS Core.
 *
 * On a process restart the deterministic continuation never asks the model
 * to "continue the task" from a synthetic prompt: the runtime reads this
 * record, rebuilds a tool workspace bound to the ORIGINAL run, replays the
 * same tool call (original ``tool_call_id``) and lets the executor resume
 * from its checkpointed state. The record lives under
 * ``state/hil/continuations/<requirement_id>.json`` inside the task root.
 */
export interface SuspendedExecutionContinuation {
  schema_version: 1;
  requirement_id: string;
  task_id: string;
  run_id: string;
  pi_session_id: string;
  tool_call_id: string;
  spec: DatasetExecutionSpec;
  source_files: Record<string, string>;
  mapping_files: Record<string, string>;
  metadata_files: Record<string, string>;
  registered_source_asset_ids: string[];
  created_at: string;
}

/** ``<taskRoot>/state/hil/continuations/<requirementId>.json``. */
export function continuationPath(
  taskRoot: string,
  requirementId: string,
): string {
  requireSafeId(requirementId, "requirement_id");
  return path.join(taskRoot, "state", "hil", "continuations", `${requirementId}.json`);
}

/** Atomic write (tmp + rename) so a crash never leaves a partial record. */
export async function saveExecutionContinuation(
  taskRoot: string,
  continuation: SuspendedExecutionContinuation,
): Promise<void> {
  await writeJsonAtomic(continuationPath(taskRoot, continuation.requirement_id), continuation);
}

function parseContinuation(value: unknown): SuspendedExecutionContinuation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) return null;
  for (const name of ["requirement_id", "task_id", "run_id", "pi_session_id", "tool_call_id", "created_at"] as const) {
    if (typeof record[name] !== "string" || record[name].trim() === "") return null;
  }
  for (const name of ["spec", "source_files", "mapping_files", "metadata_files"] as const) {
    if (record[name] === null || typeof record[name] !== "object" || Array.isArray(record[name])) {
      return null;
    }
  }
  if (record.registered_source_asset_ids !== undefined &&
      (!Array.isArray(record.registered_source_asset_ids) ||
       record.registered_source_asset_ids.some((assetId) => typeof assetId !== "string" || !/^asset_[0-9a-f]{64}$/.test(assetId)))) {
    return null;
  }
  return {
    ...record,
    registered_source_asset_ids: Array.isArray(record.registered_source_asset_ids)
      ? record.registered_source_asset_ids as string[]
      : [],
  } as unknown as SuspendedExecutionContinuation;
}

export async function readExecutionContinuation(
  taskRoot: string,
  requirementId: string,
): Promise<SuspendedExecutionContinuation | null> {
  try {
    const value = await readJsonFileOrNull<unknown>(continuationPath(taskRoot, requirementId));
    return value === null ? null : parseContinuation(value);
  } catch {
    return null;
  }
}
