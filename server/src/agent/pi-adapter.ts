/**
 * Public entry of the Pi adapter package. The implementation lives in
 * ``server/src/agent/pi/`` (one module per concern); this file only
 * re-exports the stable surface consumed by the runtime, tests, and
 * skill-iteration service. Importers outside the package must import from
 * here, keeping the Pi-owned-package boundary enforced by
 * ``server/tests/pi-import-boundary.test.ts``.
 *
 * Package layout:
 * - ``pi/types.ts``           — upstream session/event + adapter options types
 * - ``pi/bounded.ts``         — bounded-value helpers and turn-progress guards
 * - ``pi/model-profile.ts``   — model-config → provider payload translation
 * - ``pi/budget.ts``          — compaction/retry/budget math, recovery classification
 * - ``pi/prompt.ts``          — frozen-context section + curated tool catalog prompt
 * - ``pi/tools.ts``           — tool bridge, activation tool, confined read tool
 * - ``pi/upstream-event.ts``  — Pi AgentSessionEvent → PiUpstreamEvent mapping
 * - ``pi/session-config.ts``  — BioMedSessionConfig validation
 * - ``pi/upstream-session.ts``— real Pi session factory (recovery, reconcile, probe)
 * - ``pi/one-shot.ts``        — tool-free one-shot generation (skill self-iteration)
 * - ``pi/session.ts``         — PiBioMedAgentSession (durable turn lifecycle)
 * - ``pi/adapter.ts``         — PiAgentAdapter (session composition entry)
 */

export type {
  PiAgentAdapterOptions,
  PiUpstreamEvent,
  PiUpstreamSession,
} from "./pi/types.js";
export {
  MAX_STALLED_LENGTH_CONTINUATIONS,
  MIN_PROGRESS_CHARS,
} from "./pi/bounded.js";
export {
  applyModelProfileToPayload,
  resolveRequestMaxTokens,
} from "./pi/model-profile.js";
export {
  isRecoverablePiProviderError,
  isRecoverablePiStreamError,
  resolveManualPiCompactionOverrides,
  resolvePiCompactionOverrides,
  resolvePiCompactionTargetTokens,
  resolvePiRetryOverrides,
  resolveSessionBudget,
  shouldReconfigureSession,
} from "./pi/budget.js";
export {
  SYSTEM_CONTEXT_SECTION_BEGIN,
  SYSTEM_CONTEXT_SECTION_END,
  systemContextSection,
  toolCatalogPrompt,
} from "./pi/prompt.js";
export {
  activationToolDefinition,
  canonicalSkillRoots,
  curateSkillsOverride,
  SKILL_READ_TOOL_NAME,
  skillReadToolDefinition,
  toPiCustomTools,
  TOOL_ACTIVATION_NAME,
} from "./pi/tools.js";
export { toUpstreamEvent } from "./pi/upstream-event.js";
export { generateOneShotText, type OneShotTextGenerationInput } from "./pi/one-shot.js";
export { PiBioMedAgentSession } from "./pi/session.js";
export { PiAgentAdapter } from "./pi/adapter.js";
