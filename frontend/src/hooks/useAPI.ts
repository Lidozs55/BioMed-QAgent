import { useMemo } from "react";

import type {
  ArtifactRecord,
  ContinueTaskInput,
  DatabaseRecord,
  EventPage,
  MessagePage,
  ResumeRunInput,
  StartTaskInput,
  TaskPage,
  TaskRunAccepted,
  TaskSnapshot,
} from "@/runtime/contracts";

const DEFAULT_BASE_URL = "/api/v1";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AdmissionOptions {
  requestId?: string;
}

export class APIError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : `API request failed (${status})`);
    this.name = "APIError";
    this.status = status;
    this.detail = detail;
  }
}

export interface APIClient {
  fetchDatabases: () => Promise<DatabaseRecord[]>;
  fetchTasks: (params?: {
    limit?: number;
    cursor?: string | null;
  }) => Promise<TaskPage>;
  fetchTask: (taskId: string) => Promise<TaskSnapshot>;
  fetchMessages: (
    taskId: string,
    params?: { limit?: number; cursor?: string | null },
  ) => Promise<MessagePage>;
  fetchEvents: (
    taskId: string,
    params?: { afterSequence?: number; limit?: number },
  ) => Promise<EventPage["events"]>;
  createTask: (
    input: StartTaskInput,
    options?: AdmissionOptions,
  ) => Promise<TaskRunAccepted>;
  startImportTask: (
    input: { files: File[]; note?: string },
    options?: AdmissionOptions,
  ) => Promise<TaskRunAccepted>;
  continueTask: (
    taskId: string,
    input: ContinueTaskInput,
    options?: AdmissionOptions,
  ) => Promise<TaskRunAccepted>;
  cancelRun: (taskId: string, runId: string) => Promise<TaskSnapshot>;
  resumeRun: (
    taskId: string,
    runId: string,
    input: ResumeRunInput,
  ) => Promise<TaskSnapshot>;
  deleteTask: (taskId: string) => Promise<void>;
  fetchArtifacts: (taskId: string) => Promise<ArtifactRecord[]>;
  getArtifactUrl: (taskId: string, artifactId: string) => string;
  getCacheExportUrl: () => string;
}

interface APIClientOptions {
  baseUrl?: string;
  fetcher?: FetchLike;
  randomUUID?: () => string;
}

function defaultRandomUUID(): string {
  return globalThis.crypto.randomUUID();
}

function encodeId(value: string): string {
  return encodeURIComponent(value);
}

function withQuery(
  url: string,
  entries: ReadonlyArray<readonly [string, string | number | null | undefined]>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized.length === 0 ? url : `${url}?${serialized}`;
}

async function errorDetail(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "detail" in body) {
      return Reflect.get(body, "detail");
    }
    return body;
  } catch {
    return response.statusText || `API request failed (${response.status})`;
  }
}

export function createAPIClient(options: APIClientOptions = {}): APIClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetcher: FetchLike = options.fetcher ?? ((input, init) => fetch(input, init));
  const randomUUID = options.randomUUID ?? defaultRandomUUID;

  const parseResponse = async <T>(response: Response): Promise<T> => {
    if (!response.ok) {
      throw new APIError(response.status, await errorDetail(response));
    }
    return response.json() as Promise<T>;
  };

  const request = async <T>(url: string, init?: RequestInit): Promise<T> =>
    parseResponse<T>(await fetcher(url, init));

  const requestVoid = async (url: string, init?: RequestInit): Promise<void> => {
    const response = await fetcher(url, init);
    if (!response.ok) {
      throw new APIError(response.status, await errorDetail(response));
    }
  };

  const postAdmission = async <T>(url: string, body: string): Promise<T> => {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    };
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch {
      response = await fetcher(url, init);
    }
    return parseResponse<T>(response);
  };

  const requestId = (provided?: string): string =>
    provided ?? `req_${randomUUID()}`;

  return {
    fetchDatabases: () =>
      request<{ databases: DatabaseRecord[] }>(`${baseUrl}/databases`).then(
        ({ databases }) => databases,
      ),

    fetchTasks: (params = {}) =>
      request<TaskPage>(
        withQuery(`${baseUrl}/tasks`, [
          ["limit", params.limit],
          ["cursor", params.cursor],
        ]),
      ),

    fetchTask: (taskId) =>
      request<TaskSnapshot>(`${baseUrl}/tasks/${encodeId(taskId)}`),

    fetchMessages: (taskId, params = {}) =>
      request<MessagePage>(
        withQuery(`${baseUrl}/tasks/${encodeId(taskId)}/messages`, [
          ["limit", params.limit],
          ["cursor", params.cursor],
        ]),
      ),

    fetchEvents: (taskId, params = {}) =>
      request<EventPage>(
        withQuery(`${baseUrl}/tasks/${encodeId(taskId)}/events`, [
          ["after_sequence", params.afterSequence],
          ["limit", params.limit],
        ]),
      ).then(({ events }) => events),

    createTask: (input, admission = {}) => {
      const body = JSON.stringify({
        request_id: requestId(admission.requestId),
        input: input.input,
        databases: input.databases,
        mode: input.mode,
      });
      return postAdmission<TaskRunAccepted>(`${baseUrl}/tasks`, body);
    },

    startImportTask: ({ files, note }, admission = {}) => {
      const form = new FormData();
      form.set("request_id", requestId(admission.requestId));
      if (note !== undefined && note.trim().length > 0) {
        form.set("input", note.trim());
      }
      for (const file of files) {
        form.append("files", file, file.name);
      }
      return fetcher(`${baseUrl}/import/tasks`, {
        method: "POST",
        body: form,
      }).then((response) => parseResponse<TaskRunAccepted>(response));
    },

    continueTask: (taskId, input, admission = {}) => {
      const body = JSON.stringify({
        request_id: requestId(admission.requestId),
        input: input.input,
      });
      return postAdmission<TaskRunAccepted>(
        `${baseUrl}/tasks/${encodeId(taskId)}/runs`,
        body,
      );
    },

    cancelRun: (taskId, runId) =>
      request<TaskSnapshot>(
        `${baseUrl}/tasks/${encodeId(taskId)}/runs/${encodeId(runId)}/cancel`,
        { method: "POST" },
      ),

    resumeRun: (taskId, runId, input) =>
      request<TaskSnapshot>(
        `${baseUrl}/tasks/${encodeId(taskId)}/runs/${encodeId(runId)}/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: input.request_id,
            decision: input.decision,
            detail: input.detail,
          }),
        },
      ),

    deleteTask: (taskId) =>
      requestVoid(`${baseUrl}/tasks/${encodeId(taskId)}`, {
        method: "DELETE",
      }),

    fetchArtifacts: (taskId) =>
      request<{ artifacts: ArtifactRecord[] }>(
        `${baseUrl}/tasks/${encodeId(taskId)}/artifacts`,
      ).then(({ artifacts }) => artifacts),

    getArtifactUrl: (taskId, artifactId) =>
      `${baseUrl}/tasks/${encodeId(taskId)}/artifacts/${encodeId(artifactId)}`,

    getCacheExportUrl: () => `${baseUrl}/cache/export`,
  };
}

export function useAPI(): APIClient {
  return useMemo(() => createAPIClient(), []);
}
