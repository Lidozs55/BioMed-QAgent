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

// Re-export all settings contracts for backward compatibility
export type { CapabilitySource, ModelSettings, ModelSettingsUpdate, ModelPreviewRequest, VendorInfo, ModelInfo, SettingsAPIClient, DeclarativeOperation, DeclarativeSkillManifest, DatabaseOperationUpdatePatch, DatabaseUpdatePatch, SkillManifest, SkillDetail, SkillValidation } from "@/hooks/settingsContracts";
export type { ContextBudgetSettings } from "@/hooks/settingsContracts";

// Re-export APIError class, normalizer, and runtime parsers
export { APIError, normalizeErrorDetail } from "@/hooks/settingsContracts";
export { parseModelSettings, parseVendorsEnvelope, parseModelsEnvelope } from "@/hooks/settingsParsers";
import { APIError } from "@/hooks/settingsContracts";
import { parseModelSettings, parseVendorsEnvelope, parseModelsEnvelope } from "@/hooks/settingsParsers";
import {
  parseEventPage, parseMessagePage, parseTaskPage,
  parseTaskRunAccepted, parseTaskSnapshot,
} from "@/lib/apiResponseParsers";
import {
  parseArtifactsEnvelope, parseDatabasesEnvelope,
  parseSkillDetail, parseSkillsEnvelope, parseSkillValidation,
} from "@/lib/apiEnvelopeParsers";
import type { SettingsAPIClient } from "@/hooks/settingsContracts";

const DEFAULT_BASE_URL = "/api/v1";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AdmissionOptions {
  requestId?: string;
}

export interface APIClient {
  fetchDatabases: () => Promise<DatabaseRecord[]>;
  fetchTasks: (params?: { limit?: number; cursor?: string | null }) => Promise<TaskPage>;
  fetchTask: (taskId: string) => Promise<TaskSnapshot>;
  fetchMessages: (taskId: string, params?: { limit?: number; cursor?: string | null }) => Promise<MessagePage>;
  fetchEvents: (taskId: string, params?: { afterSequence?: number; limit?: number }) => Promise<EventPage["events"]>;
  createTask: (input: StartTaskInput, options?: AdmissionOptions) => Promise<TaskRunAccepted>;
  startImportTask: (input: { files: File[]; note?: string }, options?: AdmissionOptions) => Promise<TaskRunAccepted>;
  continueTask: (taskId: string, input: ContinueTaskInput, options?: AdmissionOptions) => Promise<TaskRunAccepted>;
  cancelRun: (taskId: string, runId: string) => Promise<TaskSnapshot>;
  resumeRun: (taskId: string, runId: string, input: ResumeRunInput) => Promise<TaskSnapshot>;
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

export function createAPIClient(options: APIClientOptions = {}): APIClient & SettingsAPIClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetcher: FetchLike = options.fetcher ?? ((input, init) => fetch(input, init));
  const randomUUID = options.randomUUID ?? defaultRandomUUID;

  /** Parse any response as unknown — callers narrow with endpoint-specific helpers. */
  const parseResponse = async (response: Response): Promise<unknown> => {
    if (!response.ok) throw new APIError(response.status, await errorDetail(response));
    return response.json();
  };

  /** Generic request — returns unknown, callers parse with concrete parsers. */
  const request = async (url: string, init?: RequestInit): Promise<unknown> => {
    return parseResponse(await fetcher(url, init));
  };

  const requestVoid = async (url: string, init?: RequestInit): Promise<void> => {
    const response = await fetcher(url, init);
    if (!response.ok) throw new APIError(response.status, await errorDetail(response));
  };

  /** POST with retry — returns unknown, callers parse with concrete parsers. */
  const postAdmission = async (url: string, body: string): Promise<unknown> => {
    const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body };
    let response: Response;
    try { response = await fetcher(url, init); }
    catch { response = await fetcher(url, init); }
    return parseResponse(response);
  };

  const requestId = (provided?: string): string => provided ?? `req_${randomUUID()}`;

  return {
    fetchDatabases: () =>
      request(`${baseUrl}/databases`).then((b) => parseDatabasesEnvelope(b)).then(({ databases }) => databases),
    fetchTasks: (params = {}) =>
      request(withQuery(`${baseUrl}/tasks`, [["limit", params.limit], ["cursor", params.cursor]])).then((b) => parseTaskPage(b)),
    fetchTask: (taskId) => request(`${baseUrl}/tasks/${encodeId(taskId)}`).then((b) => parseTaskSnapshot(b)),
    fetchMessages: (taskId, params = {}) =>
      request(withQuery(`${baseUrl}/tasks/${encodeId(taskId)}/messages`, [["limit", params.limit], ["cursor", params.cursor]])).then((b) => parseMessagePage(b)),
    fetchEvents: (taskId, params = {}) =>
      request(withQuery(`${baseUrl}/tasks/${encodeId(taskId)}/events`, [["after_sequence", params.afterSequence], ["limit", params.limit]])).then((b) => parseEventPage(b)).then(({ events }) => events),
    createTask: (input, admission = {}) => postAdmission(`${baseUrl}/tasks`, JSON.stringify({
      request_id: requestId(admission.requestId), input: input.input, databases: input.databases, mode: input.mode,
    })).then((b) => parseTaskRunAccepted(b)),
    startImportTask: ({ files, note }, admission = {}) => {
      const form = new FormData();
      form.set("request_id", requestId(admission.requestId));
      if (note !== undefined && note.trim().length > 0) form.set("input", note.trim());
      for (const file of files) form.append("files", file, file.name);
      return fetcher(`${baseUrl}/import/tasks`, { method: "POST", body: form }).then((r) => parseResponse(r).then((b) => parseTaskRunAccepted(b)));
    },
    continueTask: (taskId, input, admission = {}) =>
      postAdmission(`${baseUrl}/tasks/${encodeId(taskId)}/runs`, JSON.stringify({
        request_id: requestId(admission.requestId), input: input.input,
      })).then((b) => parseTaskRunAccepted(b)),
    cancelRun: (taskId, runId) =>
      request(`${baseUrl}/tasks/${encodeId(taskId)}/runs/${encodeId(runId)}/cancel`, { method: "POST" }).then((b) => parseTaskSnapshot(b)),
    resumeRun: (taskId, runId, input) =>
      request(`${baseUrl}/tasks/${encodeId(taskId)}/runs/${encodeId(runId)}/resume`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: input.request_id, decision: input.decision, detail: input.detail }),
      }).then((b) => parseTaskSnapshot(b)),
    deleteTask: (taskId) => requestVoid(`${baseUrl}/tasks/${encodeId(taskId)}`, { method: "DELETE" }),
    fetchArtifacts: (taskId) =>
      request(`${baseUrl}/tasks/${encodeId(taskId)}/artifacts`).then((b) => parseArtifactsEnvelope(b)).then(({ artifacts }) => artifacts),
    getArtifactUrl: (taskId, artifactId) => `${baseUrl}/tasks/${encodeId(taskId)}/artifacts/${encodeId(artifactId)}`,
    getCacheExportUrl: () => `${baseUrl}/cache/export`,
    fetchSettings: () => fetcher(`${baseUrl}/settings`).then((r) => parseResponse(r).then((b) => parseModelSettings(b))),
    saveSettings: (changes) => fetcher(`${baseUrl}/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) }).then((r) => parseResponse(r).then((b) => parseModelSettings(b))),
    fetchVendors: () => fetcher(`${baseUrl}/vendors`).then((r) => parseResponse(r).then((b) => parseVendorsEnvelope(b)).then(({ vendors }) => vendors)),
    fetchModels: (preview) => fetcher(`${baseUrl}/models`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview_base_url: preview.baseUrl, preview_api_key: preview.apiKey ?? "", ...(preview.query === undefined ? {} : { query: preview.query }) }) }).then((r) => parseResponse(r).then((b) => parseModelsEnvelope(b)).then(({ models }) => models)),
    fetchSkills: () => request(`${baseUrl}/skills`).then((b) => parseSkillsEnvelope(b)).then(({ skills }) => skills),
    fetchSkill: (name) => request(`${baseUrl}/skills/${encodeId(name)}`).then((b) => parseSkillDetail(b)),
    setSkillEnabled: (name, enabled) => requestVoid(`${baseUrl}/skills/${encodeId(name)}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
    rollbackSkill: (name) => requestVoid(`${baseUrl}/skills/${encodeId(name)}/rollback`, { method: "POST" }),
    deleteSkill: (name) => requestVoid(`${baseUrl}/skills/${encodeId(name)}`, { method: "DELETE" }),
    validateSkill: (file) => { const form = new FormData(); form.set("file", file, file.name); return request(`${baseUrl}/skills/validate`, { method: "POST", body: form }).then((b) => parseSkillValidation(b)); },
    uploadSkill: (file) => { const form = new FormData(); form.set("file", file, file.name); return requestVoid(`${baseUrl}/skills/upload`, { method: "POST", body: form }); },
    createDatabase: (manifest) => requestVoid(`${baseUrl}/databases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manifest) }),
    updateDatabase: (name, manifest) => requestVoid(`${baseUrl}/databases/${encodeId(name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manifest) }),
    deleteDatabase: (name) => requestVoid(`${baseUrl}/databases/${encodeId(name)}`, { method: "DELETE" }),
  };
}

export function useAPI(): APIClient & SettingsAPIClient {
  return useMemo(() => createAPIClient(), []);
}
