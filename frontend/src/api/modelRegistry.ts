/**
 * Model registry API client (``/api/v1/model-registry/*``).
 *
 * NOTE: the server model-registry responses are currently typed through the
 * contracts DTOs but not field-level validated at the wire boundary (the
 * other endpoint groups parse). Runtime validation for these DTOs is tracked
 * as follow-up work — see docs/TODO.md.
 */
import type { Http } from "@/api/http";
import { parseModelSettings } from "@biomed/contracts";
import type {
  DiscoveredModelInfo,
  ManagedModelInfo,
  ManagedModelInput,
  ModelSettings,
  ParameterSpec,
  ProviderInfo,
  ProviderInput,
  ProviderUpdateInput,
} from "@/api/types";

export interface ModelRegistryApi {
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
}

export function createModelRegistryApi(http: Http): ModelRegistryApi {
  return {
    fetchProviders: () =>
      http.request(`${http.baseUrl}/model-registry/providers`).then((b) => b as ProviderInfo[]),
    createProvider: (input) =>
      http.request(`${http.baseUrl}/model-registry/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }).then((b) => b as ProviderInfo),
    updateProvider: (id, patch) =>
      http.request(`${http.baseUrl}/model-registry/providers/${http.encodeId(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then((b) => b as ProviderInfo),
    deleteProvider: (id) =>
      http.requestVoid(`${http.baseUrl}/model-registry/providers/${http.encodeId(id)}`, { method: "DELETE" }),
    discoverProviderModels: (id) =>
      http.request(`${http.baseUrl}/model-registry/providers/${http.encodeId(id)}/discover`, { method: "POST" }).then((b) => b as DiscoveredModelInfo[]),
    fetchProviderParamSpecs: (id) =>
      http.request(`${http.baseUrl}/model-registry/providers/${http.encodeId(id)}/param-specs`).then((b) => b as ParameterSpec[]),
    fetchManagedModels: () =>
      http.request(`${http.baseUrl}/model-registry/models`).then((b) => b as ManagedModelInfo[]),
    createManagedModel: (input) =>
      http.request(`${http.baseUrl}/model-registry/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }).then((b) => b as ManagedModelInfo),
    updateManagedModel: (id, patch) =>
      http.request(`${http.baseUrl}/model-registry/models/${http.encodeId(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then((b) => b as ManagedModelInfo),
    deleteManagedModel: (id) =>
      http.requestVoid(`${http.baseUrl}/model-registry/models/${http.encodeId(id)}`, { method: "DELETE" }),
    activateManagedModel: (id) =>
      http.request(`${http.baseUrl}/model-registry/models/${http.encodeId(id)}/activate`, { method: "POST" }).then((b) => parseModelSettings(b)),
  };
}