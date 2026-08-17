/**
 * Frontend wire DTO types + client interfaces.
 *
 * Transport types are shared from ``@biomed/contracts`` (single definition
 * across processes); this module re-exports them for frontend consumers and
 * keeps the client-side interfaces (``SettingsAPIClient``) in the frontend.
 */
import {
  RUNTIME_LIMIT_RANGES,
  DEFAULT_RUNTIME_LIMITS,
  type CapabilitySource,
  ContextBudgetSettings,
  DatabaseDetail,
  DatabaseItem,
  DatabaseOperationUpdatePatch,
  DatabaseUpdatePatch,
  DeclarativeOperation,
  DeclarativeSkillManifest,
  DiscoveredModelInfo,
  DraftSource,
  ManagedModelInfo,
  ManagedModelInput,
  ModelCapabilities,
  ModelInfo,
  ModelPreviewRequest,
  ModelSettings,
  ModelSettingsUpdate,
  ParameterSpec,
  Personality,
  PersonalizationSettings,
  PersonalizationUpdate,
  ProviderInfo,
  ProviderInput,
  ProviderUpdateInput,
  RuntimeLimits,
  ServerSource,
  VendorInfo,
} from "@biomed/contracts";
import type {
  AgentPermissionPreset,
  AgentPermissionRuleInput,
  AgentPermissionSettings,
} from "./settings";

export type {
  CapabilitySource,
  ContextBudgetSettings,
  DatabaseDetail,
  DatabaseItem,
  DatabaseOperationUpdatePatch,
  DatabaseUpdatePatch,
  DeclarativeOperation,
  DeclarativeSkillManifest,
  DiscoveredModelInfo,
  DraftSource,
  ManagedModelInfo,
  ManagedModelInput,
  ModelCapabilities,
  ModelInfo,
  ModelPreviewRequest,
  ModelSettings,
  ModelSettingsUpdate,
  ParameterSpec,
  Personality,
  PersonalizationSettings,
  PersonalizationUpdate,
  ProviderInfo,
  ProviderInput,
  ProviderUpdateInput,
  RuntimeLimits,
  ServerSource,
  VendorInfo,
};

export { DEFAULT_RUNTIME_LIMITS, RUNTIME_LIMIT_RANGES };

export type {
  AgentPermissionPreset,
  AgentPermissionRuleInput,
  AgentPermissionSettings,
};

/* ---- Settings API client (frontend-side interface) ---- */
export interface SettingsAPIClient {
  fetchSettings: () => Promise<ModelSettings>;
  saveSettings: (changes: ModelSettingsUpdate) => Promise<ModelSettings>;
  fetchPersonalization: () => Promise<PersonalizationSettings>;
  savePersonalization: (changes: PersonalizationUpdate) => Promise<PersonalizationSettings>;
  fetchVendors: () => Promise<VendorInfo[]>;
  fetchModels: (preview: ModelPreviewRequest) => Promise<ModelInfo[]>;
  fetchProviders: () => Promise<ProviderInfo[]>;
  createProvider: (input: ProviderInput) => Promise<ProviderInfo>;
  updateProvider: (id: string, patch: ProviderUpdateInput) => Promise<ProviderInfo>;
  deleteProvider: (id: string) => Promise<void>;
  discoverProviderModels: (id: string) => Promise<DiscoveredModelInfo[]>;
  fetchProviderParamSpecs: (id: string) => Promise<ParameterSpec[]>;
  fetchManagedModels: () => Promise<ManagedModelInfo[]>;
  createManagedModel: (input: ManagedModelInput) => Promise<ManagedModelInfo>;
  updateManagedModel: (
    id: string,
    patch: Partial<ManagedModelInput>,
  ) => Promise<ManagedModelInfo>;
  deleteManagedModel: (id: string) => Promise<void>;
  activateManagedModel: (id: string) => Promise<ModelSettings>;
  fetchDatabases: () => Promise<DatabaseItem[]>;
  fetchDatabase: (name: string) => Promise<DatabaseDetail>;
  setDatabaseEnabled: (name: string, enabled: boolean) => Promise<void>;
  createDatabase: (manifest: DeclarativeSkillManifest) => Promise<DatabaseDetail>;
  updateDatabase: (name: string, patch: DatabaseUpdatePatch) => Promise<DatabaseDetail>;
  deleteDatabase: (name: string) => Promise<void>;
  fetchAgentPermissions: () => Promise<AgentPermissionSettings>;
  setAgentPermissionsPreset: (preset: AgentPermissionPreset) => Promise<AgentPermissionSettings>;
  setAgentPermissionsPersistentExec: (enabled: boolean) => Promise<AgentPermissionSettings>;
  addAgentPermissionRule: (rule: AgentPermissionRuleInput) => Promise<AgentPermissionSettings>;
  removeAgentPermissionRule: (ruleId: string) => Promise<AgentPermissionSettings>;
  fetchAgentTempGrants: () => Promise<AgentTempGrant[]>;
  revokeAgentTempGrant: (grantId: string) => Promise<void>;
}

/** Active temporary (run/task) grant, listable + revocable from settings. */
export interface AgentTempGrant {
  id: string;
  capability: "fs.read" | "fs.write" | "fs.edit" | "process.exec";
  scope: "workspace" | "task_output" | "framework_internal" | "sensitive" | "project" | "external";
  /** Canonical root the grant covers (subtree); null = whole scope. */
  root: string | null;
  boundTo: "run" | "task";
  taskId: string;
  runId: string;
  grantedAt: string;
}