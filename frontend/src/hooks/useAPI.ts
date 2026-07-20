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

export interface ModelSettings {
  base_url: string;
  api_key: string;
  api_key_configured: boolean;
  model_name: string;
  max_tokens: number;
  advanced: {
    temperature?: number;
    top_p?: number;
    repetition_penalty?: number;
    enable_search?: boolean;
    thinking_mode?: boolean;
  };
}

export interface ModelSettingsUpdate {
  base_url?: string;
  api_key?: string;
  model_name?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  repetition_penalty?: number;
  enable_search?: boolean;
  thinking_mode?: boolean;
}

export interface ModelPreviewRequest {
  baseUrl: string;
  apiKey?: string;
  query?: string;
}

export interface VendorInfo {
  id: string;
  name: string;
  base_url: string;
  description: string;
  recommended: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  context_window: number;
  suggested_max_tokens: number;
}

export interface SkillManifest {
  name: string;
  display_name: string;
  version: string;
  category: string;
  description: string;
  origin: "builtin" | "package";
  supported_sources: string[];
  operations: string[];
  enabled: boolean;
  user_selectable: boolean;
  pipeline_supported: boolean;
  available?: boolean;
  load_error?: string | null;
}

export interface DeclarativeOperation {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  timeout_seconds?: number;
  extract?: string | null;
}

export interface DeclarativeSkillManifest {
  schema_version: "1.0";
  name: string;
  display_name: string;
  version: string;
  category: string;
  description: string;
  supported_sources: string[];
  operations: DeclarativeOperation[];
  enabled?: boolean;
  user_selectable: boolean;
  pipeline_supported: false;
  requirements?: string[];
}

export interface DatabaseOperationUpdatePatch {
  name: string;
  description?: string;
  method?: DeclarativeOperation["method"];
  url?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  timeout_seconds?: number;
  extract?: string | null;
}

export interface DatabaseUpdatePatch {
  display_name?: string;
  description?: string;
  operation?: DatabaseOperationUpdatePatch;
}

export interface SkillDetail {
  manifest: SkillManifest;
  current_version: string;
  versions: string[];
  package_kind: "manifest" | "zip";
  warning: string | null;
  available: boolean;
  load_error: string | null;
  declarative_manifest: DeclarativeSkillManifest | null;
}

export interface SkillValidation {
  valid: boolean;
  skill: SkillManifest;
  warning: string | null;
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

export interface SettingsAPIClient {
  fetchSettings: () => Promise<ModelSettings>;
  saveSettings: (changes: ModelSettingsUpdate) => Promise<ModelSettings>;
  fetchVendors: () => Promise<VendorInfo[]>;
  fetchModels: (preview: ModelPreviewRequest) => Promise<ModelInfo[]>;
  fetchSkills: () => Promise<SkillManifest[]>;
  fetchSkill: (name: string) => Promise<SkillDetail>;
  setSkillEnabled: (name: string, enabled: boolean) => Promise<void>;
  rollbackSkill: (name: string) => Promise<void>;
  deleteSkill: (name: string) => Promise<void>;
  validateSkill: (file: File) => Promise<SkillValidation>;
  uploadSkill: (file: File) => Promise<void>;
  createDatabase: (manifest: DeclarativeSkillManifest) => Promise<void>;
  updateDatabase: (name: string, patch: DatabaseUpdatePatch) => Promise<void>;
  deleteDatabase: (name: string) => Promise<void>;
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

export function createAPIClient(options: APIClientOptions = {}): APIClient & SettingsAPIClient {
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

    fetchSettings: () => request<ModelSettings>(`${baseUrl}/settings`),

    saveSettings: (changes) => request<ModelSettings>(`${baseUrl}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    }),

    fetchVendors: () => request<{ vendors: VendorInfo[] }>(`${baseUrl}/vendors`).then(({ vendors }) => vendors),

    fetchModels: (preview) => request<{ models: ModelInfo[] }>(`${baseUrl}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview_base_url: preview.baseUrl,
        preview_api_key: preview.apiKey ?? "",
        ...(preview.query === undefined ? {} : { query: preview.query }),
      }),
    }).then(({ models }) => models),

    fetchSkills: () => request<{ skills: SkillManifest[] }>(`${baseUrl}/skills`).then(({ skills }) => skills),
    fetchSkill: (name) => request<SkillDetail>(`${baseUrl}/skills/${encodeId(name)}`),
    setSkillEnabled: (name, enabled) => request<unknown>(
      `${baseUrl}/skills/${encodeId(name)}/${enabled ? "enable" : "disable"}`,
      { method: "POST" },
    ).then(() => undefined),
    rollbackSkill: (name) => request<unknown>(`${baseUrl}/skills/${encodeId(name)}/rollback`, { method: "POST" }).then(() => undefined),
    deleteSkill: (name) => request<unknown>(`${baseUrl}/skills/${encodeId(name)}`, { method: "DELETE" }).then(() => undefined),
    validateSkill: (file) => {
      const form = new FormData();
      form.set("file", file, file.name);
      return request<SkillValidation>(`${baseUrl}/skills/validate`, { method: "POST", body: form });
    },
    uploadSkill: (file) => {
      const form = new FormData();
      form.set("file", file, file.name);
      return request<unknown>(`${baseUrl}/skills/upload`, { method: "POST", body: form }).then(() => undefined);
    },
    createDatabase: (manifest) => request<unknown>(`${baseUrl}/databases`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manifest),
    }).then(() => undefined),
    updateDatabase: (name, manifest) => request<unknown>(`${baseUrl}/databases/${encodeId(name)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manifest),
    }).then(() => undefined),
    deleteDatabase: (name) => request<unknown>(`${baseUrl}/databases/${encodeId(name)}`, { method: "DELETE" }).then(() => undefined),
  };
}

export function useAPI(): APIClient & SettingsAPIClient {
  return useMemo(() => createAPIClient(), []);
}
