/**
 * Settings / personalization / vendors / discovery API client
 * (``/api/v1/settings``, ``/api/v1/personalization``, ``/api/v1/vendors``,
 * ``/api/v1/models``).
 */
import type { Http } from "@/api/http";
import {
  parseModelSettings,
  parseModelsEnvelope,
  parsePersonalization,
  parseVendorsEnvelope,
} from "@biomed/contracts";
import type {
  ModelInfo,
  ModelPreviewRequest,
  ModelSettings,
  ModelSettingsUpdate,
  PersonalizationSettings,
  PersonalizationUpdate,
  VendorInfo,
} from "@/api/types";

export interface SettingsApi {
  fetchSettings: () => Promise<ModelSettings>;
  saveSettings: (changes: ModelSettingsUpdate) => Promise<ModelSettings>;
  fetchPersonalization: () => Promise<PersonalizationSettings>;
  savePersonalization: (changes: PersonalizationUpdate) => Promise<PersonalizationSettings>;
  fetchVendors: () => Promise<VendorInfo[]>;
  fetchModels: (preview: ModelPreviewRequest) => Promise<ModelInfo[]>;
  fetchAgentPermissions: () => Promise<AgentPermissionSettings>;
  setAgentPermissionsPreset: (preset: AgentPermissionPreset) => Promise<AgentPermissionSettings>;
  addAgentPermissionRule: (rule: AgentPermissionRuleInput) => Promise<AgentPermissionSettings>;
  removeAgentPermissionRule: (ruleId: string) => Promise<AgentPermissionSettings>;
}

export type AgentPermissionPreset = "restricted" | "ask_when_needed" | "full_access";

export interface AgentPermissionRuleInput {
  capability: "fs.read" | "fs.write" | "fs.edit";
  path: string;
  recursive: boolean;
  policy: "allow" | "ask" | "deny";
}

export interface AgentPermissionSettings {
  schema_version: 1;
  preset: AgentPermissionPreset;
  rules: Array<AgentPermissionRuleInput & { id: string }>;
  persistent_exec_allow: boolean;
}

export function createSettingsApi(http: Http): SettingsApi {
  return {
    fetchSettings: async () =>
      parseModelSettings(await http.request(`${http.baseUrl}/settings`)),
    saveSettings: (changes) =>
      http.request(`${http.baseUrl}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      }).then((b) => parseModelSettings(b)),
    fetchPersonalization: () =>
      http.request(`${http.baseUrl}/personalization`).then((b) => parsePersonalization(b)),
    savePersonalization: (changes) =>
      http.request(`${http.baseUrl}/personalization`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      }).then((b) => parsePersonalization(b)),
    fetchVendors: () =>
      http.request(`${http.baseUrl}/vendors`).then((b) => parseVendorsEnvelope(b)).then(({ vendors }) => vendors),
    fetchModels: (preview) =>
      http.request(`${http.baseUrl}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preview_base_url: preview.baseUrl,
          preview_api_key: preview.apiKey ?? "",
          ...(preview.query === undefined ? {} : { query: preview.query }),
        }),
      }).then((b) => parseModelsEnvelope(b)).then(({ models }) => models),
    fetchAgentPermissions: () =>
      http.request(`${http.baseUrl}/settings/agent-permissions`).then((b) => b as unknown as AgentPermissionSettings),
    setAgentPermissionsPreset: (preset) =>
      http.request(`${http.baseUrl}/settings/agent-permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset }),
      }).then((b) => b as unknown as AgentPermissionSettings),
    addAgentPermissionRule: (rule) =>
      http.request(`${http.baseUrl}/settings/agent-permissions/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      }).then((b) => b as unknown as AgentPermissionSettings),
    removeAgentPermissionRule: (ruleId) =>
      http.request(`${http.baseUrl}/settings/agent-permissions/rules/${http.encodeId(ruleId)}`, {
        method: "DELETE",
      }).then((b) => b as unknown as AgentPermissionSettings),
  };
}