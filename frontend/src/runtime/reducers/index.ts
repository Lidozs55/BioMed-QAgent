import type { EventEnvelope } from "../contracts";
import type { AgentRuntimeData } from "../types";
import { capTaskItems, updateClassification } from "./shared";
import {
  applyAssistantEvent,
  applyStageProgressEvent,
  applyToolCalledEvent,
  applyToolCompletedEvent,
  applyToolStartedEvent,
} from "./stream";
import {
  applyContextUsageEvent,
  applyConversationCompactedEvent,
  applyConversationCompactionFailedEvent,
  applyConversationCompactionStartedEvent,
  applyFixtureEvent,
  applyProviderSearchInfoEvent,
  applyPublicationCreatedEvent,
  applyRunQueuedEvent,
  applyRunSteeredEvent,
  applyRunTerminalEvent,
  applyRunTransitionEvent,
  applySubagentEvent,
  applySubagentStatusEvent,
  applyWarningEvent,
} from "./runtime";
import {
  applyArtifactProducedEvent,
  applyOperationEvent,
  applyStageTransitionEvent,
  pruneStageItemsForOperationRuns,
} from "./pipeline";
import { applyUserInputEvent } from "./hil";
import { applyPermissionEvent } from "./permissions";

export {
  isActiveStatus,
  createInitialRuntimeState,
  createTaskProjection,
  compareTaskIds,
  mergeTaskPage,
  mergeOlderMessagePage,
  hydrateTaskSnapshot,
  prepareTaskSnapshotReplay,
  restoreTaskProjection,
  markTaskContiguous,
} from "./shared";

export {
  reduceAssistantStreamFrames,
  deactivateAssistantStreams,
} from "./stream";

export function reduceRuntimeEvent(
  state: AgentRuntimeData,
  envelope: EventEnvelope,
): AgentRuntimeData {
  const current = state.tasksById[envelope.task_id];
  if (current === undefined || envelope.sequence <= current.lastSequence) {
    return state;
  }
  if (envelope.sequence > current.lastSequence + 1) {
    // A frame at N was dropped or rejected before this one (e.g. unknown
    // type, schema drift, or a transport-level reject). Never advance the
    // cursor past the gap: a missed user_input_required would otherwise be
    // permanently unrecoverable. Record a recoverable gap marker and leave
    // the cursor at the last applied sequence so the transport can replay
    // from there. The event payload is NOT reduced.
    return {
      ...state,
      tasksById: {
        ...state.tasksById,
        [envelope.task_id]: {
          ...current,
          sequenceGap: {
            expected: current.lastSequence + 1,
            received: envelope.sequence,
          },
        },
      },
    };
  }

  const payload = envelope.payload;
  let task = current;

  switch (payload.type) {
    case "subagent_queued": {
      task = applySubagentEvent(task, envelope, payload);
      break;
    }
    case "subagent_started":
    case "subagent_progress":
    case "subagent_completed":
    case "subagent_failed":
    case "subagent_cancelled":
    case "subagent_interrupted":
    case "subagent_cancel_requested":
    case "subagent_input_required":
    case "subagent_input_resumed": {
      task = applySubagentStatusEvent(task, envelope, payload);
      break;
    }
    case "run_queued": {
      task = applyRunQueuedEvent(task, envelope, payload);
      break;
    }
    case "run_steered": {
      task = applyRunSteeredEvent(task, envelope, payload);
      break;
    }
    case "run_started":
    case "run_finalizing":
    case "run_cancel_requested": {
      task = applyRunTransitionEvent(task, envelope, payload);
      break;
    }
    case "run_completed":
    case "run_failed":
    case "run_cancelled":
    case "run_interrupted": {
      task = applyRunTerminalEvent(task, envelope, payload);
      break;
    }
    case "publication_created": {
      task = applyPublicationCreatedEvent(task, envelope, payload);
      break;
    }
    case "user_input_required":
    case "user_input_resumed": {
      task = applyUserInputEvent(task, envelope, payload);
      break;
    }
    case "permission_requested":
    case "permission_resolved": {
      task = applyPermissionEvent(task, envelope, payload);
      break;
    }
    case "plan_ready":
    case "task_created":
    case "task_recovered":
    case "task_cancel_requested":
    case "task_cancelled":
    case "task_completed":
    case "task_failed": {
      task = applyFixtureEvent(task, envelope, payload);
      break;
    }
    case "assistant_delta":
    case "assistant_reasoning_delta": {
      task = applyAssistantEvent(task, envelope, payload);
      break;
    }
    case "tool_started": {
      task = applyToolStartedEvent(task, envelope, payload);
      break;
    }
    case "tool_completed": {
      task = applyToolCompletedEvent(task, envelope, payload);
      break;
    }
    case "tool_called": {
      task = applyToolCalledEvent(task, envelope, payload);
      break;
    }
    case "warning": {
      task = applyWarningEvent(task, envelope, payload);
      break;
    }
    case "provider_search_info": {
      task = applyProviderSearchInfoEvent(task, envelope, payload);
      break;
    }
    case "conversation_compacted": {
      task = applyConversationCompactedEvent(task, envelope, payload);
      break;
    }
    case "conversation_compaction_started": {
      task = applyConversationCompactionStartedEvent(task, envelope, payload);
      break;
    }
    case "conversation_compaction_failed": {
      task = applyConversationCompactionFailedEvent(task, envelope, payload);
      break;
    }
    case "context_usage": {
      task = applyContextUsageEvent(task, payload);
      break;
    }
    case "artifact_produced": {
      task = applyArtifactProducedEvent(task, envelope, payload);
      break;
    }
    case "stage_started":
    case "stage_completed":
    case "stage_failed":
    case "stage_skipped": {
      task = applyStageTransitionEvent(task, envelope, payload);
      break;
    }
    case "stage_progress": {
      task = applyStageProgressEvent(task, envelope, payload);
      break;
    }
    case "operation_started":
    case "operation_progress":
    case "operation_completed":
    case "operation_failed": {
      task = applyOperationEvent(task, envelope, payload);
      break;
    }
    default:
      break;
  }

  // R1S-01: keep the timeline by operation identity — once a run has
  // operation items, its stage/progress items are pruned (legacy replays
  // without operation events are unaffected).
  task = pruneStageItemsForOperationRuns(task);

  // Timeline bound: drop the oldest items once a session grows past the cap
  // (streaming never removes anything on its own). Earlier messages remain
  // reachable via ``olderMessagesCursor`` pagination.
  task = capTaskItems(task);

  task = {
    ...task,
    lastSequence: envelope.sequence,
    sequenceGap: null,
    summary: {
      ...task.summary,
      updated_at: envelope.timestamp,
      latest_sequence: envelope.sequence,
    },
  };
  const classification = updateClassification(state, task);
  return {
    ...state,
    tasksById: { ...state.tasksById, [envelope.task_id]: task },
    ...classification,
  };
}
