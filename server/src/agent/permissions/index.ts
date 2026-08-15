export {
  PermissionBroker,
  summarize,
  type BrokerDecision,
  type BrokerEvaluateInput,
  type BrokerOptions,
} from "./broker.js";
export { classifyCanonicalPath, type ClassificationRoots } from "./classifier.js";
export { PermissionEvaluator, type EvaluatorOptions, type EvaluationResult } from "./evaluator.js";
export {
  InMemoryPermissionAuditSink,
  AppendOnlyPermissionAuditSink,
  type PermissionAuditRecord,
  type PermissionAuditSink,
} from "./audit.js";
export { TemporaryGrantStore } from "./grants.js";
export {
  InMemoryPermissionPolicyStore,
  JsonPermissionPolicyStore,
  type PermissionPolicyStore,
} from "./policy-store.js";
export {
  canonicalizeWithAncestor,
  canonicalIsWithin,
  normalizeAgentPathFor,
  PathNormalizationError,
  type NormalizedPath,
} from "./path-normalizer.js";
export { ProtectedPaths } from "./protected-paths.js";
export {
  DEFAULT_PERMISSION_SETTINGS,
  PRESET_MATRICES,
  PermissionDeniedError,
  type FilePermissionRule,
  type GrantScope,
  type PermissionCapability,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionPreset,
  type PermissionRequest,
  type PermissionSettings,
  type PolicyMatrix,
  type ResourceScope,
} from "./types.js";
