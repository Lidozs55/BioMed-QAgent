// Public entry point for the runtime reducer.
//
// The implementation has been split into domain-based submodules under
// `./reducers/`. This file re-exports the public surface so that every
// existing consumer (`from "@/runtime/reducer"` or `from "./reducer"`)
// continues to work without any change.
//
// Submodule layout (dependency hierarchy: shared ← stream ← {runtime,
// pipeline, hil} ← index):
//   - reducers/shared.ts   — shared types, helpers, constants, hydration
//   - reducers/stream.ts   — real-time streaming events (assistant/tool deltas,
//                            stage_progress, assistant stream projection)
//   - reducers/runtime.ts  — runtime lifecycle events (run_*, task_*, warning,
//                            conversation_compacted, subagent_*, plan_ready)
//   - reducers/pipeline.ts — pipeline stage events (stage_*, artifact_produced)
//   - reducers/hil.ts      — human-in-the-loop events (user_input_*)
//   - reducers/index.ts    — composition root: `reduceRuntimeEvent` dispatcher

export {
  isActiveStatus,
  createInitialRuntimeState,
  createTaskProjection,
  compareTaskIds,
  mergeTaskPage,
  mergeOlderMessagePage,
  hydrateTaskSnapshot,
  prepareTaskSnapshotReplay,
  markTaskContiguous,
  reduceAssistantStreamFrames,
  deactivateAssistantStreams,
  reduceRuntimeEvent,
} from "./reducers";
