/**
 * Pi-side tool surface: the BioMed → Pi tool bridge (with central argument
 * validation), the bounded tool-activation tool, and the confined skill/code
 * read tool with skill-root curation.
 */

import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  createReadToolDefinition,
  defineTool,
  type ResourceDiagnostic,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { BioMedAgentTool } from "../contracts.js";
import { errorResult } from "../tools/result.js";
import { validateToolArgumentsOrThrow } from "../tools/schema-validation.js";

export const TOOL_ACTIVATION_NAME = "activate_agent_tools";
const MAX_ACTIVATED_TOOLS = 12;
/**
 * Pi appends the `<available_skills>` listing to a custom system prompt only
 * when the active tool set contains a tool named exactly ``read`` (upstream
 * ``customPromptHasRead`` gate), and its listing tells the model to load a
 * skill's file with that tool. The session read tool below IS that gate — a
 * read surface confined to the curated skill roots plus the configured code
 * read roots.
 */
export const SKILL_READ_TOOL_NAME = "read";

export function toPiCustomTools(
  tools: readonly BioMedAgentTool[],
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_toolCallId, parameters, signal) {
      try {
        validateToolArgumentsOrThrow(parameters, tool.parameters);
      } catch (error) {
        throw new Error(errorResult(error).content, { cause: error });
      }
      const result = await tool.execute(parameters, signal, { toolCallId: _toolCallId });
      if (result.isError === true) throw new Error(result.content);
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
  }));
}

export function activationToolDefinition(
  tools: readonly BioMedAgentTool[],
  initialToolNames: readonly string[],
  setActiveTools: (names: readonly string[]) => void,
): ToolDefinition {
  const allNames = new Set(tools.map((tool) => tool.name));
  const initial = [...new Set(initialToolNames)].filter((name) => allNames.has(name));
  const optional = tools
    .filter((tool) => !initial.includes(tool.name))
    .map((tool) => tool.name)
    .sort();
  const activated = new Set<string>();
  return {
    name: TOOL_ACTIVATION_NAME,
    label: "Activate Agent Tools",
    description:
      "Add a bounded set of optional tools for the next model turn. Previously activated tools and Dataset Core tools remain available.",
    parameters: {
      type: "object",
      properties: {
        tool_names: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ACTIVATED_TOOLS,
          items: { type: "string", enum: optional },
        },
      },
      required: ["tool_names"],
      additionalProperties: false,
    },
    async execute(_toolCallId, parameters) {
      const record = parameters as Record<string, unknown>;
      const requested = Array.isArray(record.tool_names)
        ? record.tool_names.filter((name): name is string => typeof name === "string")
        : [];
      const selected = [...new Set(requested)].filter((name) => optional.includes(name));
      const unknown = [...new Set(requested)].filter((name) => !optional.includes(name));
      if (selected.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, error: "tool_names must contain an optional catalog tool" }),
          }],
          details: { ok: false, unknown_tools: unknown },
        };
      }
      for (const name of selected) activated.add(name);
      const activeOptional = optional.filter((name) => activated.has(name));
      setActiveTools([...initial, TOOL_ACTIVATION_NAME, ...activeOptional]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            activated_tools: selected,
            active_optional_tools: activeOptional,
            unknown_tools: unknown,
            next_turn: true,
          }),
        }],
        details: {
          ok: true,
          activated_tools: selected,
          active_optional_tools: activeOptional,
          unknown_tools: unknown,
          next_turn: true,
        },
      };
    },
  };
}

/** Canonical (resolve + realpath) forms of skill roots; both are kept so
 * containment survives symlinked checkouts (e.g. a /home alias over the
 * real mount). */
export function canonicalSkillRoots(skillRoots: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const root of skillRoots) {
    const resolved = path.resolve(root);
    roots.add(resolved);
    try {
      roots.add(realpathSync(resolved));
    } catch {
      // A missing root is already reported by optionalSkillRoots(); keep the
      // resolved form so filtering stays deterministic.
    }
  }
  return [...roots];
}

function isUnderRoots(candidate: string, roots: readonly string[]): boolean {
  return roots.some(
    (root) => candidate === root || candidate.startsWith(root + path.sep),
  );
}

/**
 * DefaultResourceLoader also scans ``~/.agents/skills`` and every ancestor
 * ``.agents/skills`` directory up to the git root, so user-level skills load
 * alongside the curated roots. Keep only skills that live under the session's
 * curated skill roots; without this filter, enabling the ``<available_skills>``
 * listing would leak user-level skills into production prompts.
 */
export function curateSkillsOverride(
  skillRoots: readonly string[],
): (
  base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] },
) => { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const roots = canonicalSkillRoots(skillRoots);
  return (base) => ({
    skills: base.skills.filter((skill) =>
      isUnderRoots(
        path.resolve(skill.baseDir || path.dirname(skill.filePath)),
        roots,
      )),
    diagnostics: base.diagnostics,
  });
}

/**
 * The model-facing read surface for skill documents and repository source
 * code. Reusing Pi's read tool keeps the native offset/limit and truncation
 * semantics, while the injected operations confine every access to the
 * curated skill roots plus the configured code read roots (checked on the
 * resolved path and again on the realpath so symlinks cannot escape).
 */
export function skillReadToolDefinition(
  skillRoots: readonly string[],
  codeReadRoots: readonly string[] = [],
): ToolDefinition {
  const roots = [...canonicalSkillRoots(skillRoots), ...canonicalSkillRoots(codeReadRoots)];
  const guard = (absolutePath: string): void => {
    if (!isUnderRoots(path.resolve(absolutePath), roots)) {
      throw new Error(
        "read accepts curated skill documents and repository source files; " +
          "the path must stay inside the skill roots listed in <available_skills> " +
          "or the configured code read roots",
      );
    }
    let real: string;
    try {
      real = realpathSync(absolutePath);
    } catch {
      return; // missing files surface through access() with the native error
    }
    if (!isUnderRoots(real, roots)) {
      throw new Error(
        "Path resolves outside the curated skill and code read roots; refusing to read",
      );
    }
  };
  return defineTool(createReadToolDefinition(path.sep, {
    operations: {
      access: async (absolutePath) => {
        guard(absolutePath);
        await access(absolutePath);
      },
      readFile: async (absolutePath) => {
        guard(absolutePath);
        return readFile(absolutePath);
      },
    },
  }));
}
