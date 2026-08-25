import { describe, expect, test } from "vitest";

import {
  SKILL_TOOL_MAP,
  SKILL_TOOL_NAMES,
  toolOwner,
  type SkillToolMapping,
} from "../src/agent/skills/skill-tool-map.js";

const SKILL_NAME = /^[a-z][a-z0-9_-]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

function collect<T>(iterable: Iterable<T>): T[] {
  return [...iterable];
}

describe("stable Skill ↔ Tool mapping", () => {
  test("maps every migrated skill with bounded function and routing guidance", () => {
    expect(SKILL_TOOL_MAP.length).toBeGreaterThanOrEqual(18);
    for (const mapping of SKILL_TOOL_MAP) {
      expect(mapping.name, mapping.name).toMatch(SKILL_NAME);
      expect(
        ["discovery", "acquisition", "processing", "analysis"],
        mapping.name,
      ).toContain(mapping.category);
      for (const source of mapping.sources) {
        expect(source.trim(), mapping.name).not.toBe("");
      }
      expect(mapping.description.length, mapping.name).toBeGreaterThan(0);
      expect(mapping.description.length, mapping.name).toBeLessThanOrEqual(200);
      expect(mapping.routing.length, mapping.name).toBeGreaterThan(0);
      expect(mapping.routing.length, mapping.name).toBeLessThanOrEqual(280);
      expect(mapping.tools.length, mapping.name).toBeGreaterThan(0);
    }
  });

  test("skill names are unique", () => {
    const names = SKILL_TOOL_MAP.map((mapping) => mapping.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("tool names are unique, snake-case, and each belongs to exactly one skill", () => {
    const tools = SKILL_TOOL_MAP.flatMap((mapping) => mapping.tools);
    expect(new Set(tools).size).toBe(tools.length);
    expect(collect(SKILL_TOOL_NAMES).length).toBe(tools.length);
    for (const tool of tools) {
      expect(tool, tool).toMatch(TOOL_NAME);
    }
    for (const mapping of SKILL_TOOL_MAP) {
      for (const tool of mapping.tools) {
        expect(toolOwner(tool), tool).toBe(mapping.name);
      }
    }
  });

  test("unknown tool names resolve to undefined", () => {
    expect(toolOwner("find_skill")).toBeUndefined();
    expect(toolOwner("invoke_skill")).toBeUndefined();
    expect(toolOwner("create_skill")).toBeUndefined();
  });

  test("the trusted Dataset Core tools stay mapped to dataset-construction", () => {
    const core = SKILL_TOOL_MAP.find((mapping) => mapping.name === "dataset-construction");
    expect(core).toBeDefined();
    expect(core?.tools).toEqual([
      "inspect_dataset_build_routes",
      "validate_dataset_build",
      "execute_dataset_build",
      "prepare_dynamic_family_build",
      "submit_dynamic_family_build",
    ]);
    expect(core?.routing).toMatch(/inspect routes first/i);
    expect(core?.routing).toMatch(/exact static match/i);
    expect(core?.routing).toMatch(/acquisition-only carriers/i);
  });

  test("routes GWAS Catalog through its wired Dynamic Family provider", () => {
    const gwas = SKILL_TOOL_MAP.find((mapping) => mapping.name === "gwas_catalog");
    expect(gwas?.routing).toMatch(/gwas-catalog\.associations\.v1/i);
    expect(gwas?.routing).toMatch(/wired for Dynamic Family/i);
    expect(gwas?.routing).toMatch(/does not require a static GWAS family/i);
  });

  test("mapping entries are frozen at runtime", () => {
    const entry = SKILL_TOOL_MAP[0] as SkillToolMapping & { name: string };
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      entry.name = "tampered";
    }).toThrow();
  });
});
