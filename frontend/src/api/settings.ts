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
  };
}