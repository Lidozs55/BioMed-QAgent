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
  parseSkillIterationCandidate,
  parseSkillIterationContext,
  parseVendorsEnvelope,
} from "@biomed/contracts";
import type {
  AgentTempGrant,
  ModelInfo,
  ModelPreviewRequest,
  ModelSettings,
  ModelSettingsUpdate,
  PersonalizationSettings,
  PersonalizationUpdate,
  SkillIterationCandidate,
  SkillIterationContext,
  StartSkillIterationRequest,
  VendorInfo,
} from "@/api/types";

export interface SettingsApi {
  fetchSettings: () => Promise<ModelSettings>;
  saveSettings: (changes: ModelSettingsUpdate) => Promise<ModelSettings>;
  fetchPersonalization: () => Promise<PersonalizationSettings>;
  savePersonalization: (changes: PersonalizationUpdate) => Promise<PersonalizationSettings>;
  fetchSkillIterationContext: () => Promise<SkillIterationContext>;
  startSkillIteration: (request: StartSkillIterationRequest) => Promise<SkillIterationCandidate>;
  fetchVendors: () => Promise<VendorInfo[]>;
  fetchModels: (preview: ModelPreviewRequest) => Promise<ModelInfo[]>;
  fetchAgentPermissions: () => Promise<AgentPermissionSettings>;
  setAgentPermissionsPreset: (preset: AgentPermissionPreset) => Promise<AgentPermissionSettings>;
  setAgentPermissionsPersistentExec: (enabled: boolean) => Promise<AgentPermissionSettings>;
  addAgentPermissionRule: (rule: AgentPermissionRuleInput) => Promise<AgentPermissionSettings>;
  removeAgentPermissionRule: (ruleId: string) => Promise<AgentPermissionSettings>;
  fetchAgentTempGrants: () => Promise<AgentTempGrant[]>;
  revokeAgentTempGrant: (grantId: string) => Promise<void>;
}

export type AgentPermissionPreset = "restricted" | "ask_when_needed" | "full_access";

export interface AgentPermissionRuleInput {
  capability: "fs.read" | "fs.write" | "fs.edit";
  /**
   * Resource scope the rule binds to (round-4 audit): the evaluator requires
   * the request scope to equal the rule's scope, so a ``project`` rule never
   * covers ``sensitive``/``external`` targets. ``framework_internal`` is not
   * selectable — the control plane is hard-denied before rules are consulted.
   */
  resource_scope: "workspace" | "task_output" | "sensitive" | "project" | "external";
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
    fetchSkillIterationContext: () =>
      http.request(http.baseUrl + "/skill-iterations/context")
        .then((body) => parseSkillIterationContext(body)),
    startSkillIteration: (request) =>
      http.request(http.baseUrl + "/skill-iterations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }).then((body) => parseSkillIterationCandidate(body)),
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
    setAgentPermissionsPersistentExec: (enabled) =>
      http.request(`${http.baseUrl}/settings/agent-permissions/persistent-exec`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
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
    fetchAgentTempGrants: () =>
      http.request(`${http.baseUrl}/settings/agent-permissions/temp-grants`)
        .then((b) => (b as { grants: AgentTempGrant[] }).grants),
    revokeAgentTempGrant: (grantId) =>
      http.requestVoid(`${http.baseUrl}/settings/agent-permissions/temp-grants/${http.encodeId(grantId)}`, {
        method: "DELETE",
      }),
  };
}
