/**
 * System-prompt sections assembled by the adapter: the frozen execution
 * context delimiters and the curated skill/tool catalog briefing.
 */

import type { BioMedAgentTool } from "../contracts.js";
import { SKILL_TOOL_MAP } from "../skills/skill-tool-map.js";

/**
 * Delimited marker pair for frozen run context carried by ``systemContext``.
 * The agent must treat the section as binding evidence and never echo it into
 * the user-visible conversation.
 */
export const SYSTEM_CONTEXT_SECTION_BEGIN = "[Begin Frozen execution context]";
export const SYSTEM_CONTEXT_SECTION_END = "[End Frozen execution context]";

/** Appends the serialized frozen run context to the system prompt. */
export function systemContextSection(systemContext: string | undefined): string {
  if (systemContext === undefined || systemContext.trim() === "") return "";
  return [
    "",
    "",
    SYSTEM_CONTEXT_SECTION_BEGIN,
    systemContext.trim(),
    SYSTEM_CONTEXT_SECTION_END,
  ].join("\n");
}

export function toolCatalogPrompt(
  tools: readonly BioMedAgentTool[],
  initialToolNames: readonly string[],
): string {
  if (tools.length === 0) return "";
  const initial = new Set(initialToolNames);
  const available = new Map(tools.map((tool) => [tool.name, tool]));
  const mappedToolNames = new Set<string>();
  const skillEntries = SKILL_TOOL_MAP.flatMap((skill) => {
    const skillTools = skill.tools.filter((name) => available.has(name));
    if (skillTools.length === 0) return [];
    for (const name of skillTools) mappedToolNames.add(name);
    const toolList = skillTools
      .map((name) => `${name}${initial.has(name) ? " (active)" : ""}`)
      .join(", ");
    return [
      `- ${skill.name} [${skill.category}]`,
      `  Function: ${skill.description}`,
      `  Route/boundary: ${skill.routing}`,
      `  Tools: ${toolList}`,
    ];
  });
  const otherTools = tools
    .filter((tool) => !mappedToolNames.has(tool.name))
    .map((tool) => {
      const summary = tool.description.replace(/\s+/g, " ").trim().slice(0, 180);
      return `- ${tool.name}${initial.has(tool.name) ? " (active)" : ""}: ${summary}`;
    });
  return [
    "",
    "Available curated skill/tool map (complete for this session):",
    "Use it before substantive work to choose the route and respect each trust boundary.",
    "Each entry has a curated SKILL.md; before relying on a source's specific rules, load that document with the read tool.",
    "Tools marked (active) have full schemas now. For other listed tools, call activate_agent_tools before use; activation does not bypass permissions, validation, or publication gates.",
    "A tool call to a listed tool that is NOT active fails with 'Tool not found' — this never means the tool is missing. Exactly one recovery exists: call activate_agent_tools with that tool's name, then retry the call with its real schema. Do not invent parameters or guess signatures for inactive tools; the catalog above is the only schema source.",
    ...skillEntries,
    ...(otherTools.length === 0
      ? []
      : [
          "Other optional tools (not owned by a curated biomedical skill):",
          ...otherTools,
        ]),
  ].join("\n");
}
