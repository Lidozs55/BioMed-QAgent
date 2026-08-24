/**
 * React hook surface for the API client.
 *
 * The actual client lives in ``frontend/src/api/`` (http transport +
 * per-endpoint modules + composition in ``client.ts``); this module only
 * memoizes one client instance per mount and re-exports the shared types/
 * parsers for backward compatibility.
 */
import { useMemo } from "react";

import { createAPIClient, type APIClient } from "@/api/client";
import type { SettingsAPIClient } from "@/api/types";

// Re-export wire DTO types for backward compatibility
// (canonical definitions live in @biomed/contracts, surfaced via @/api/types)
export type { CapabilitySource, ModelSettings, ModelSettingsUpdate, ModelPreviewRequest, VendorInfo, ModelInfo, SettingsAPIClient, DeclarativeOperation, DeclarativeSkillManifest, DatabaseItem, DatabaseDetail, DatabaseOperationUpdatePatch, DatabaseUpdatePatch, ParameterSpec, ModelCapabilities, ProviderInfo, ProviderInput, ProviderUpdateInput, ManagedModelInfo, ManagedModelInput, DiscoveredModelInfo, Personality, PersonalizationSettings, PersonalizationUpdate, SkillIterationCandidate, SkillIterationContext, StartSkillIterationRequest } from "@/api/types";
export type { ContextBudgetSettings } from "@/api/types";
export type { SteerResponse } from "@/api/tasks";
export type { APIClient } from "@/api/client";
export type { FetchLike } from "@/api/http";

// Re-export APIError class, normalizer, and runtime parsers
export { APIError, normalizeErrorDetail } from "@/api/errors";
export { parseModelSettings, parseVendorsEnvelope, parseModelsEnvelope, parsePersonalization, parseSkillIterationCandidate, parseSkillIterationContext } from "@biomed/contracts";
export { createAPIClient } from "@/api/client";

export function useAPI(): APIClient & SettingsAPIClient {
  return useMemo(() => createAPIClient(), []);
}
