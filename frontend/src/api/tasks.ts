/**
 * Task/run/event/artifact API client (``/api/v1/tasks`` and friends).
 */
import { APIError } from "@/api/errors";
import type { AdmissionOptions, Http } from "@/api/http";
import {
  parseEventPage, parseMessagePage, parseTaskPage,
  parseTaskRunAccepted, parseTaskSnapshot,
} from "@/lib/apiResponseParsers";
import { parseArtifactsEnvelope } from "@/lib/apiEnvelopeParsers";
import type {
  ArtifactRecord,
  ContinueTaskInput,
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
  ) => Promise<void>;
  /** Resumes an interrupted download directly (no AI pass). */
  resumeDownload: (
    taskId: string,
    input: { tool_name: string; arguments: Record<string, unknown> },
    options?: AdmissionOptions,
  ) => Promise<TaskRunAccepted>;
  deleteTask: (taskId: string) => Promise<void>;
  fetchArtifacts: (taskId: string) => Promise<ArtifactRecord[]>;
  getArtifactUrl: (taskId: string, artifactId: string) => string;
  getCacheExportUrl: () => string;
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
        body: JSON.stringify({ request_id: input.request_id, decision: input.decision, detail: input.detail }),      }).then((b) => parseTaskSnapshot(b)),
    resolvePermission: (taskId, runId, requestId, decision, grantScope) =>
      http.requestVoid(
        `${http.baseUrl}/tasks/${http.encodeId(taskId)}/runs/${http.encodeId(runId)}/permissions/${http.encodeId(requestId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            ...(grantScope === undefined ? {} : { grant_scope: grantScope }),
          }),
        },
      ),
    resumeDownload: (taskId, input, admission = {}) =>
      http.postAdmission(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/downloads/resume`, JSON.stringify({
        request_id: http.requestId(admission.requestId), tool_name: input.tool_name, arguments: input.arguments,
      })).then((b) => parseTaskRunAccepted(b)),
    deleteTask: (taskId) =>
      http.requestVoid(`${http.baseUrl}/tasks/${http.encodeId(taskId)}`, { method: "DELETE" }),
    fetchArtifacts: (taskId) =>
      http.request(`${http.baseUrl}/tasks/${http.encodeId(taskId)}/artifacts`).then((b) => parseArtifactsEnvelope(b)).then(({ artifacts }) => artifacts),
    getArtifactUrl: (taskId, artifactId) =>
      `${http.baseUrl}/tasks/${http.encodeId(taskId)}/artifacts/${http.encodeId(artifactId)}`,
    getCacheExportUrl: () => `${http.baseUrl}/cache/export`,
  };
}