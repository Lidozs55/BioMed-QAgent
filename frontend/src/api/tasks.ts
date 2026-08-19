/**
 * Task/run/event/artifact API client (``/api/v1/tasks`` and friends).
 */
import { APIError } from "@/api/errors";
import type { AdmissionOptions, Http } from "@/api/http";
import {
  parseDownloadResumeAccepted, parseEventPage, parseMessagePage, parseTaskPage,
  parseTaskRunAccepted, parseTaskSnapshot,
} from "@/lib/apiResponseParsers";
import { parseArtifactsEnvelope } from "@/lib/apiEnvelopeParsers";
import type {
  ArtifactRecord,
  ContinueTaskInput,
  DownloadResumeAccepted,
  EventPage,
  MessagePage,
  ResumeRunInput,
  StartTaskInput,
  TaskPage,
  TaskRunAccepted,
  TaskSnapshot,
} from "@/runtime/contracts";

export interface SteerResponse {
  status: "steered";
  task_id: string;
  run_id: string;
  message_id?: string | null;
  content?: string | null;
}

/** Summary row of a registered local cache dataset (``/api/v1/cache/datasets``). */
export interface CacheDatasetSummary {
  dataset_id: string;
  namespace: string;
  row_count: number;
  published_at: string;
  keywords: string[];
}

export interface CacheDatasetPage {
  items: CacheDatasetSummary[];
}

function parseCacheDatasetPage(json: unknown): CacheDatasetPage {
  const obj = json as Record<string, unknown> | null;
  if (obj === null || typeof obj !== "object" || !Array.isArray(obj["items"])) {
    throw new APIError(502, "Invalid cache dataset list response");
  }
  const items: CacheDatasetSummary[] = [];
  for (const value of obj["items"]) {
    const item = value as Record<string, unknown> | null;
    if (
      item === null || typeof item !== "object" ||
      typeof item["dataset_id"] !== "string" ||
      typeof item["namespace"] !== "string" ||
      typeof item["row_count"] !== "number" ||
      typeof item["published_at"] !== "string"
    ) {
      throw new APIError(502, "Invalid cache dataset summary");
    }
    items.push({
      dataset_id: item["dataset_id"],
      namespace: item["namespace"],
      row_count: item["row_count"],
      published_at: item["published_at"],
      keywords: Array.isArray(item["keywords"])
        ? item["keywords"].filter((value): value is string => typeof value === "string")
        : [],
    });
  }
  return { items };
}

function parseSteerResponse(json: unknown): SteerResponse {
  const obj = json as Record<string, unknown> | null;
  if (
    obj === null ||
    typeof obj !== "object" ||
    obj["status"] !== "steered" ||
    typeof obj["task_id"] !== "string" ||
    typeof obj["run_id"] !== "string"
  ) {
    throw new APIError(502, "Invalid steer response");
  }
  return {
    status: "steered",
    task_id: obj["task_id"],
    run_id: obj["run_id"],
    message_id: typeof obj["message_id"] === "string" ? obj["message_id"] : null,
    content: typeof obj["content"] === "string" ? obj["content"] : null,
  };
}

export interface TasksApi {
  fetchTasks: (params?: { limit?: number; cursor?: string | null }) => Promise<TaskPage>;
  fetchTask: (taskId: string) => Promise<TaskSnapshot>;
  fetchMessages: (taskId: string, params?: { limit?: number; cursor?: string | null }) => Promise<MessagePage>;
  fetchEvents: (taskId: string, params?: { afterSequence?: number; limit?: number }) => Promise<EventPage["events"]>;
  createTask: (input: StartTaskInput, options?: AdmissionOptions) => Promise<TaskRunAccepted>;
  startImportTask: (input: { files: File[]; note?: string }, options?: AdmissionOptions) => Promise<TaskRunAccepted>;
  continueTask: (taskId: string, input: ContinueTaskInput, options?: AdmissionOptions) => Promise<TaskRunAccepted>;
  cancelRun: (taskId: string, runId: string) => Promise<TaskSnapshot>;
  cancelSubagent: (
    taskId: string,
    runId: string,
    subagentId: string,
  ) => Promise<TaskSnapshot>;
  compactTask: (taskId: string) => Promise<void>;
  injectTaskContext: (
    taskId: string,
    text: string,
    expectedRunId?: string | null,
  ) => Promise<SteerResponse>;
  resumeRun: (taskId: string, runId: string, input: ResumeRunInput) => Promise<TaskSnapshot>;
  resolvePermission: (
    taskId: string,
    runId: string,
    requestId: string,
    decision: "allow" | "deny",
    grantScope?: "once" | "run" | "task" | "persistent",
    scopeWide?: boolean,
  ) => Promise<void>;
  /** Resumes an interrupted download directly (no AI pass). */
  resumeDownload: (
    taskId: string,
    input: {
      run_id: string;
      tool_call_id: string;
      tool_name: string;
      arguments: Record<string, unknown>;
    },
  ) => Promise<DownloadResumeAccepted>;
  cancelDownload: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  fetchArtifacts: (taskId: string) => Promise<ArtifactRecord[]>;
  getArtifactUrl: (taskId: string, artifactId: string) => string;
  getCacheExportUrl: () => string;
  fetchCacheDatasets: (params?: {
    namespace?: string;
    keyword?: string;
    limit?: number;
  }) => Promise<CacheDatasetPage>;
  deleteCacheDataset: (datasetId: string, namespace?: string) => Promise<void>;
  clearCacheDatasets: () => Promise<number>;
}

export function createTasksApi(http: Http): TasksApi {
  return {
    fetchTasks: (params = {}) =>
      http.request(http.withQuery(`${http.baseUrl}/tasks`, [["limit", params.limit], ["cursor", params.cursor]])).then((b) => parseTaskPage(b)),
    fetchTask: (taskId) =>
      http.request(`${http.baseUrl}/tasks/${http.encodeId(taskId)}`).then((b) => parseTaskSnapshot(b)),
    fetchMessages: (taskId, params = {}) =>
      http.request(http.withQuery(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/messages`, [["limit", params.limit], ["cursor", params.cursor]])).then((b) => parseMessagePage(b)),
    fetchEvents: (taskId, params = {}) =>
      http.request(http.withQuery(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/events`, [["after_sequence", params.afterSequence], ["limit", params.limit]])).then((b) => parseEventPage(b)).then(({ events }) => events),
    createTask: (input, admission = {}) =>
      http.postAdmission(`${http.baseUrl}/tasks`, JSON.stringify({
        request_id: http.requestId(admission.requestId), input: input.input, databases: input.databases, mode: input.mode,
      })).then((b) => parseTaskRunAccepted(b)),
    startImportTask: ({ files, note }, admission = {}) => {
      const form = new FormData();
      form.set("request_id", http.requestId(admission.requestId));
      if (note !== undefined && note.trim().length > 0) form.set("input", note.trim());
      for (const file of files) form.append("files", file);
      return http.fetcher(`${http.baseUrl}/import/tasks`, { method: "POST", body: form })
        .then(async (r) => { if (!r.ok) throw new APIError(r.status, await http.errorDetail(r)); return parseTaskRunAccepted(await r.json()); });
    },
    continueTask: (taskId, input, admission = {}) =>
      http.postAdmission(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/runs`, JSON.stringify({
        request_id: http.requestId(admission.requestId), input: input.input,
      })).then((b) => parseTaskRunAccepted(b)),
    cancelRun: (taskId, runId) =>
      http.request(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/runs/${http.encodeId(runId)}/cancel`, { method: "POST" }).then((b) => parseTaskSnapshot(b)),
    cancelSubagent: (taskId, runId, subagentId) =>
      http.request(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/runs/${http.encodeId(runId)}/subagents/${http.encodeId(subagentId)}/cancel`, { method: "POST" }).then((b) => parseTaskSnapshot(b)),
    compactTask: (taskId) =>
      http.requestVoid(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/compact`, { method: "POST" }),
    injectTaskContext: (taskId, text, expectedRunId = null) =>
      http.request(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/inject-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, expected_run_id: expectedRunId }),
      }).then((b) => parseSteerResponse(b)),
    resumeRun: (taskId, runId, input) =>
      http.request(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/runs/${http.encodeId(runId)}/resume`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: input.request_id, decision: input.decision, detail: input.detail }),
      }).then((b) => parseTaskSnapshot(b)),
    resolvePermission: (taskId, runId, requestId, decision, grantScope, scopeWide) =>
      http.requestVoid(
        `${http.baseUrl}/tasks/${http.encodeId(taskId)}/runs/${http.encodeId(runId)}/permissions/${http.encodeId(requestId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            ...(grantScope === undefined ? {} : { grant_scope: grantScope }),
            ...(scopeWide === true ? { scope_wide: true } : {}),
          }),
        },
      ),
    resumeDownload: (taskId, input) =>
      http.request(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/downloads/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }).then((b) => parseDownloadResumeAccepted(b)),
    cancelDownload: (taskId) =>
      http.requestVoid(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/downloads/cancel`, { method: "POST" }),

    deleteTask: (taskId) =>
      http.requestVoid(`${http.baseUrl}/tasks/${http.encodeId(taskId)}`, { method: "DELETE" }),
    fetchArtifacts: (taskId) =>
      http.request(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/artifacts`).then((b) => parseArtifactsEnvelope(b)).then(({ artifacts }) => artifacts),
    getArtifactUrl: (taskId, artifactId) =>
      `${http.baseUrl}/tasks/${http.encodeId(taskId)}/artifacts/${http.encodeId(artifactId)}`,
    getCacheExportUrl: () => `${http.baseUrl}/cache/export`,
    fetchCacheDatasets: (params = {}) =>
      http.request(http.withQuery(`${http.baseUrl}/cache/datasets`, [
        ["namespace", params.namespace],
        ["keyword", params.keyword],
        ["limit", params.limit],
      ])).then((b) => parseCacheDatasetPage(b)),
    deleteCacheDataset: (datasetId, namespace) =>
      http.requestVoid(http.withQuery(
        `${http.baseUrl}/cache/datasets/${http.encodeId(datasetId)}`,
        [["namespace", namespace]],
      ), { method: "DELETE" }),
    clearCacheDatasets: () =>
      http.request(`${http.baseUrl}/cache/datasets`, { method: "DELETE" })
        .then((b) => {
          const json = b as Record<string, unknown> | null;
          const deleted = json === null || typeof json !== "object" ? undefined : json["deleted"];
          if (typeof deleted !== "number") throw new APIError(502, "Invalid cache clear response");
          return deleted;
        }),
  };
}
