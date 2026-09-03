import type {
  EventEnvelope,
  MessageRecord,
  ModelCallUsage,
  ProviderSearchResult,
  RunUsageTotals,
  TaskPublicationSummary,
  RunRecord,
  RunStatus,
  TaskSnapshot,
  TaskSummary,
} from "@biomed/contracts";

export interface DurableTaskMetadata {
  schema_version: 1;
  task_id: string;
  mode: TaskSummary["mode"];
  databases: string[];
  title: string;
  created_at: string;
  pi_session_id?: string;
}

const ACTIVE_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "finalizing",
  "cancel_requested",
  "awaiting_user_input",
]);

function terminalSummary(
  status: RunStatus,
  event: EventEnvelope,
): RunRecord["summary"] {
  if (event.payload.type === "run_completed") {
    return {
      run_status: status,
      error_code: null,
      cancelled_at_stage: null,
      user_message: null,
    };
  }
  if (event.payload.type === "run_failed") {
    return {
      run_status: status,
      error_code: event.payload.error_code ?? "internal_error",
      cancelled_at_stage: null,
      user_message: event.payload.error,
    };
  }
  if (event.payload.type === "run_cancelled") {
    return {
      run_status: status,
      error_code: "cancelled",
      cancelled_at_stage: event.payload.cancelled_at_stage ?? null,
      user_message: event.payload.reason ?? null,
    };
  }
  if (event.payload.type === "run_interrupted") {
    return {
      run_status: status,
      error_code: "internal_error",
      cancelled_at_stage: null,
      user_message: event.payload.reason,
    };
  }
  return null;
}

function statusFor(event: EventEnvelope): RunStatus | undefined {
  switch (event.type) {
    case "run_queued": return "queued";
    case "run_started": return "running";
    case "run_finalizing": return "finalizing";
    case "run_cancel_requested": return "cancel_requested";
    case "user_input_required": return "awaiting_user_input";
    case "user_input_resumed": return "running";
    case "run_completed": return "completed";
    case "run_failed": return "failed";
    case "run_cancelled": return "cancelled";
    case "run_interrupted": return "interrupted";
    default: return undefined;
  }
}

function message(
  metadata: DurableTaskMetadata,
  event: EventEnvelope,
  role: MessageRecord["role"],
  content: string,
  ordinal: number,
): MessageRecord {
  return {
    schema_version: "1.0",
    message_id: `message_${event.event_id}`,
    task_id: metadata.task_id,
    run_id: event.run_id,
    ordinal,
    role,
    content,
    created_at: event.timestamp,
    sequence: event.sequence,
  };
}

const MAX_MESSAGE_SEARCH_RESULTS = 20;

/**
 * Merge a search_info batch into a message's aggregated list: dedupe by URL
 * (one provider search may repeat a hit across model calls) and cap the
 * total so a long agent loop cannot inflate the message record.
 */
function mergeSearchResults(
  existing: ProviderSearchResult[] | undefined,
  incoming: ProviderSearchResult[],
): ProviderSearchResult[] {
  const merged = [...(existing ?? [])];
  const seen = new Set(merged.map((result) => result.url));
  for (const result of incoming) {
    if (merged.length >= MAX_MESSAGE_SEARCH_RESULTS) break;
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    merged.push(result);
  }
  return merged;
}

function accumulateRunUsage(
  usageByRun: Map<string, RunUsageTotals>,
  runId: string,
  usage: ModelCallUsage,
): void {
  const totals: RunUsageTotals = usageByRun.get(runId) ?? {
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
  };
  totals.model_calls += 1;
  totals.input_tokens += usage.input_tokens;
  totals.output_tokens += usage.output_tokens;
  totals.cache_read_tokens += usage.cache_read_tokens;
  totals.cache_write_tokens += usage.cache_write_tokens;
  totals.total_tokens += usage.total_tokens;
  if (usage.reasoning_tokens !== undefined) {
    totals.reasoning_tokens = (totals.reasoning_tokens ?? 0) + usage.reasoning_tokens;
  }
  usageByRun.set(runId, totals);
}

export function reduceTaskEvents(
  metadata: DurableTaskMetadata,
  events: readonly EventEnvelope[],
): TaskSnapshot {
  const runs: RunRecord[] = [];
  const messages: MessageRecord[] = [];
  const publications: TaskPublicationSummary[] = [];
  const artifactIds = new Set<string>();
  const assistantByRun = new Map<string, MessageRecord>();
  const usageByRun = new Map<string, RunUsageTotals>();
  // provider_search_info batches that arrived before the run's assistant
  // message existed; merged on creation and dropped on steer boundaries.
  const pendingSearchByRun = new Map<string, ProviderSearchResult[]>();
  let currentPublicationId: string | null = null;
  let artifactCount = 0;

  for (const event of events) {
    if (event.payload.type === "run_queued" && event.run_id !== null) {
      runs.push({
        schema_version: "1.0",
        run_id: event.run_id,
        task_id: metadata.task_id,
        request_id: event.payload.request_id,
        status: "queued",
        input: event.payload.input,
        created_at: event.timestamp,
        updated_at: event.timestamp,
        started_at: null,
        finished_at: null,
        error: null,
        summary: null,
        // Events persisted before the frozen-context feature lack the field;
        // replay normalizes them to null.
        execution_context: event.payload.execution_context ?? null,
      });
      messages.push(message(metadata, event, "user", event.payload.input, messages.length + 1));
      continue;
    }

    const run = event.run_id === null
      ? undefined
      : runs.find((candidate) => candidate.run_id === event.run_id);
    if (
      event.payload.type === "context_usage" &&
      event.payload.usage !== undefined &&
      event.run_id !== null
    ) {
      accumulateRunUsage(usageByRun, event.run_id, event.payload.usage);
    }
    const nextStatus = statusFor(event);
    if (run !== undefined && nextStatus !== undefined) {
      run.status = nextStatus;
      run.updated_at = event.timestamp;
      if (nextStatus === "running" && run.started_at === null) run.started_at = event.timestamp;
      if (!ACTIVE_STATUSES.has(nextStatus)) run.finished_at = event.timestamp;
      if (event.payload.type === "run_failed") run.error = event.payload.error;
      run.summary = terminalSummary(nextStatus, event);
      const usageTotals = usageByRun.get(run.run_id);
      if (run.summary && usageTotals !== undefined) {
        run.summary.usage = usageTotals;
      }
    }

    if (event.payload.type === "assistant_delta" && event.run_id !== null) {
      const existing = assistantByRun.get(event.run_id);
      if (existing === undefined) {
        const created = message(metadata, event, "assistant", event.payload.delta, messages.length + 1);
        const pendingSearch = pendingSearchByRun.get(event.run_id);
        if (pendingSearch !== undefined && pendingSearch.length > 0) {
          created.search_results = pendingSearch;
          pendingSearchByRun.delete(event.run_id);
        }
        messages.push(created);
        assistantByRun.set(event.run_id, created);
      } else {
        existing.content += event.payload.delta;
      }
    } else if (event.payload.type === "run_steered" && event.run_id !== null) {
      messages.push(message(metadata, event, "user", event.payload.input, messages.length + 1));
      // Text generated after the direction change belongs to a new assistant
      // turn in the snapshot rather than the pre-steer assistant message.
      assistantByRun.delete(event.run_id);
      pendingSearchByRun.delete(event.run_id);
    } else if (event.payload.type === "provider_search_info" && event.run_id !== null) {
      // Attach to the run's assistant message; events may land before the
      // first delta of a run, so early batches are stashed until creation.
      const existing = assistantByRun.get(event.run_id);
      if (existing !== undefined) {
        existing.search_results = mergeSearchResults(existing.search_results, event.payload.results);
      } else {
        pendingSearchByRun.set(
          event.run_id,
          mergeSearchResults(pendingSearchByRun.get(event.run_id), event.payload.results),
        );
      }
    } else if (event.payload.type === "publication_created") {
      const publication: TaskPublicationSummary = {
        publication_id: event.payload.publication_id,
        manifest_sha256: event.payload.manifest_sha256,
        supersedes_publication_id: event.payload.supersedes_publication_id,
        published_at: event.payload.published_at,
      };
      if (!publications.some((item) => item.publication_id === publication.publication_id)) {
        publications.push(publication);
      }
      currentPublicationId = publication.publication_id;
    } else if (event.payload.type === "artifact_produced") {
      const artifactId = event.payload.artifact.artifact_id;
      if (!artifactIds.has(artifactId)) {
        artifactIds.add(artifactId);
        artifactCount += 1;
      }
    }
  }

  const latestRun = runs.at(-1);
  const status = latestRun?.status ?? "queued";
  const latestEvent = events.at(-1);
  const task: TaskSummary = {
    schema_version: "1.0",
    task_id: metadata.task_id,
    mode: metadata.mode,
    databases: metadata.databases,
    title: metadata.title,
    status,
    active_run_id: latestRun !== undefined && ACTIVE_STATUSES.has(latestRun.status)
      ? latestRun.run_id
      : null,
    created_at: metadata.created_at,
    updated_at: latestEvent?.timestamp ?? metadata.created_at,
    latest_sequence: latestEvent?.sequence ?? 0,
    artifact_count: artifactCount,
  };
  return {
    schema_version: "1.0",
    task,
    runs,
    messages,
    subagents: [],
    current_publication_id: currentPublicationId,
    publications,
    older_messages_cursor: null,
  };
}
