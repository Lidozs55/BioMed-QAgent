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
  ModelRegistryListQuery,
  ModelRegistryPage,
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
  SkillIterationCandidate,
  SkillIterationContext,
  StartSkillIterationRequest,
  VendorInfo,
} from "@biomed/contracts";
import type {
  AgentPermissionPreset,
  AgentPermissionRuleInput,
  AgentPermissionSettings,
} from "./settings";
import type { CacheDatasetPage } from "./tasks";

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
  ModelRegistryListQuery,
  ModelRegistryPage,
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
  SkillIterationCandidate,
  SkillIterationContext,
  StartSkillIterationRequest,
  VendorInfo,
};

export { DEFAULT_RUNTIME_LIMITS, RUNTIME_LIMIT_RANGES };

export type {
  AgentPermissionPreset,
  AgentPermissionRuleInput,
  AgentPermissionSettings,
};

export type {
  HILApprovalMode,
  HILApprovalScope,
  HILApprovalSettings,
} from "@biomed/contracts";
export { HIL_HUMAN_MANDATORY_SCOPES } from "@biomed/contracts";

/** Partial update for the three-tier HIL approval assignment; null clears a scope back to default_mode. */
export interface HilApprovalSettingsPatch {
  default_mode?: HILApprovalMode;
  review_modes?: Partial<Record<HILApprovalScope, HILApprovalMode | null>>;
}
import type {
  HILApprovalMode,
  HILApprovalScope,
  HILApprovalSettings,
} from "@biomed/contracts";

/* ---- Settings API client (frontend-side interface) ---- */
export interface SettingsAPIClient {
  fetchSettings: () => Promise<ModelSettings>;
  saveSettings: (changes: ModelSettingsUpdate) => Promise<ModelSettings>;
  fetchPersonalization: () => Promise<PersonalizationSettings>;
  savePersonalization: (changes: PersonalizationUpdate) => Promise<PersonalizationSettings>;
  fetchSkillIterationContext: () => Promise<SkillIterationContext>;
  startSkillIteration: (request: StartSkillIterationRequest) => Promise<SkillIterationCandidate>;
  fetchVendors: () => Promise<VendorInfo[]>;
  fetchModels: (preview: ModelPreviewRequest) => Promise<ModelInfo[]>;
  fetchProviders: () => Promise<ProviderInfo[]>;
  createProvider: (input: ProviderInput) => Promise<ProviderInfo>;
  updateProvider: (id: string, patch: ProviderUpdateInput) => Promise<ProviderInfo>;
  deleteProvider: (id: string) => Promise<void>;
  discoverProviderModels: (id: string) => Promise<DiscoveredModelInfo[]>;
  fetchProviderParamSpecs: (id: string) => Promise<ParameterSpec[]>;
  fetchManagedModels: () => Promise<ManagedModelInfo[]>;
  fetchProvidersPage: (
    query?: ModelRegistryListQuery,
  ) => Promise<ModelRegistryPage<ProviderInfo>>;
  fetchManagedModelsPage: (
    query?: ModelRegistryListQuery,
  ) => Promise<ModelRegistryPage<ManagedModelInfo>>;
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
  fetchHilApproval: () => Promise<HILApprovalSettings>;
  saveHilApproval: (patch: HilApprovalSettingsPatch) => Promise<HILApprovalSettings>;
  fetchCacheDatasets: (params?: {
    namespace?: string;
    keyword?: string;
    limit?: number;
  }) => Promise<CacheDatasetPage>;
  deleteCacheDataset: (datasetId: string, namespace?: string) => Promise<void>;
  clearCacheDatasets: () => Promise<number>;
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
