/**
 * Business tool bundle (P5-02 → P5-12).
 *
 * `createBusinessToolBundle` is the single assembly point for the curated
 * BioMed business tools registered into formal Pi sessions. It currently
 * carries the deterministic no-network tools; each Phase 5 checkpoint extends
 * the bundle with its migrated tools, and P5-12 wires the full bundle into
 * the formal runtime composition (replacing the Python business tool path).
 *
 * Rules (P5-D2 / P5-12):
 * - tool names must match SKILL_TOOL_MAP (curated) exactly;
 * - duplicate names fail closed (registry guard);
 * - user declarative database tools are appended by the caller (P5-11) and
 *   must not collide with curated names;
 * - Pi types never leak here — outputs are BioMedAgentTool[].
 */

import type { BioMedAgentTool } from "../contracts.js";
import { assertUniqueToolNames } from "./registry.js";
import { createAnalyzePapersTool, type AnalyzePapersHooks } from "./literature-understanding.js";
import {
  createResearchDataGuidanceTool,
  type ResearchDataGuidanceOptions,
} from "./guidance.js";

export interface BusinessToolBundleContext {
  /** QueryStatus/progress projection hooks (Python run_ctx.log_query parity). */
  onQuery?: AnalyzePapersHooks["onQuery"];
  /** Curated guidance docs root (tests override; default resolves the repo docs). */
  guidanceDocsRoot?: string;
  /** Enable research-only capabilities (default true; product gates may disable). */
  enabledCapabilities?: ReadonlySet<string>;
}

export interface BusinessToolBundle {
  readonly tools: readonly BioMedAgentTool[];
  readonly ownerOf: (toolName: string) => string | undefined;
}

/**
 * Deterministic subset (P5-02): analyze_papers + get_research_data_guidance.
 * Later checkpoints append their tools here before returning.
 */
export function createBusinessToolBundle(context: BusinessToolBundleContext = {}): BusinessToolBundle {
  const tools: BioMedAgentTool[] = [];
  const ownerOf = new Map<string, string>();

  const register = (tool: BioMedAgentTool, owner: string): void => {
    tools.push(tool);
    ownerOf.set(tool.name, owner);
  };

  register(createAnalyzePapersTool({ onQuery: context.onQuery }), "literature_understanding");
  register(
    createResearchDataGuidanceTool({
      docsRoot: context.guidanceDocsRoot,
    } as ResearchDataGuidanceOptions),
    "research_data_guidance",
  );

  assertUniqueToolNames(tools);
  return { tools: Object.freeze(tools), ownerOf: (name) => ownerOf.get(name) };
}
