/**
 * Deployment-owned Host resource defaults.
 *
 * These budgets describe one Application Host process, not an individual
 * user or task, so production overrides come from validated Host env config
 * rather than the Web settings API.
 */
export const DEFAULT_HOST_RESOURCE_LIMITS = Object.freeze({
  browserMaxContexts: 4,
  eventCacheMaxBytes: 256 * 1024 * 1024,
});
