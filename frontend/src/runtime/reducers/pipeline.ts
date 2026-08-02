import type {
  EventEnvelope,
  EventPayload,
} from "../contracts";
import type {
  ArtifactProjection,
  StageProjection,
  TaskProjection,
} from "../types";
import { upsertActivity, upsertItem } from "./shared";

export function applyArtifactProducedEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<EventPayload, { type: "artifact_produced" }>,
): TaskProjection {
  const artifact: ArtifactProjection = {
    artifact_id: payload.artifact.artifact_id,
    name: payload.artifact.name,
    size: payload.artifact.size_bytes,
    sha256: payload.artifact.sha256,
    media_type: payload.artifact.media_type,
    taskId: envelope.task_id,
    generatedByStepId: payload.artifact.generated_by_step_id,
  };
  const startsManifestGeneration = artifact.artifact_id === "run_manifest";
  const artifactsById = startsManifestGeneration
    ? { [artifact.artifact_id]: artifact }
    : { ...task.artifactsById, [artifact.artifact_id]: artifact };
  const artifactOrder = startsManifestGeneration
    ? [artifact.artifact_id]
    : task.artifactOrder.includes(artifact.artifact_id)
      ? task.artifactOrder
      : [...task.artifactOrder, artifact.artifact_id];
  const runId = envelope.run_id;
  const next: TaskProjection = {
    ...task,
    artifactsById,
    artifactOrder,
    artifactEventSequences: startsManifestGeneration
      ? { [artifact.artifact_id]: envelope.sequence }
      : {
          ...task.artifactEventSequences,
          [artifact.artifact_id]: envelope.sequence,
        },
    artifactManifestSequence: startsManifestGeneration
      ? envelope.sequence
      : task.artifactManifestSequence,
  };
  const artifactItemId = `artifact:${runId ?? "task"}:${artifact.artifact_id}`;
  const existingArtifactItem = next.items.find(
    (i) => i.itemId === artifactItemId,
  );
  return upsertItem(next, {
    kind: "artifact",
    itemId: artifactItemId,
    runId: runId ?? "",
    sequence: envelope.sequence,
    createdAt: existingArtifactItem?.createdAt ?? envelope.timestamp,
    artifactId: artifact.artifact_id,
    name: artifact.name,
    sizeBytes: artifact.size,
    mediaType: artifact.media_type,
  });
}

export function applyStageTransitionEvent(
  task: TaskProjection,
  envelope: EventEnvelope,
  payload: Extract<
    EventPayload,
    | { type: "stage_started" }
    | { type: "stage_completed" }
    | { type: "stage_failed" }
    | { type: "stage_skipped" }
  >,
): TaskProjection {
  if (envelope.stage_attempt_id === null) return task;
  const existing = task.stages[payload.stage];
  if (
    payload.type !== "stage_started" &&
    existing !== undefined &&
    existing.stageAttemptId !== envelope.stage_attempt_id
  ) {
    return task;
  }
  const status =
    payload.type === "stage_started" ? "running" : payload.status;
  const stage: StageProjection = {
    stage: payload.stage,
    stageAttemptId: envelope.stage_attempt_id,
    attempt:
      payload.type === "stage_started" ? payload.attempt : existing?.attempt ?? 1,
    status,
    startedAt:
      payload.type === "stage_started"
        ? envelope.timestamp
        : existing?.startedAt ?? null,
    finishedAt:
      payload.type === "stage_started" ? null : envelope.timestamp,
    outputDigest:
      payload.type === "stage_completed" ? payload.output_digest : null,
    error: payload.type === "stage_failed" ? payload.error.message : null,
    skipReason: payload.type === "stage_skipped" ? payload.reason : null,
    reusedStageAttemptId:
      payload.type === "stage_skipped"
        ? payload.reused_stage_attempt_id
        : null,
    progress: existing?.progress ?? null,
  };
  let next: TaskProjection = {
    ...task,
    stages: { ...task.stages, [payload.stage]: stage },
  };
  const runId = envelope.run_id;
  if (runId !== null) {
    next = upsertActivity(next, {
      activityId: `stage:${runId}:${payload.stage}`,
      taskId: envelope.task_id,
      runId,
      sequence: envelope.sequence,
      timestamp: envelope.timestamp,
      kind: "stage",
      status:
        payload.type === "stage_started"
          ? "started"
          : payload.type === "stage_completed"
            ? "completed"
            : payload.type === "stage_failed"
              ? "failed"
              : "skipped",
      name: null,
      input: null,
      output: null,
      isError: payload.type === "stage_failed",
      code: null,
      message: null,
      stage: payload.stage,
    });
    const stageItemId = `stage:${runId}:${payload.stage}`;
    const existingStageItem = next.items.find(
      (i) => i.itemId === stageItemId,
    );
    next = upsertItem(next, {
      kind: "stage",
      itemId: stageItemId,
      runId,
      sequence: envelope.sequence,
      createdAt: existingStageItem?.createdAt ?? envelope.timestamp,
      stage: payload.stage,
      status:
        payload.type === "stage_started"
          ? "running"
          : payload.type === "stage_completed"
            ? "completed"
            : payload.type === "stage_failed"
              ? "failed"
              : "skipped",
      attempt: stage.attempt,
      error:
        payload.type === "stage_failed" ? payload.error.message : null,
    });
  }
  return next;
}
