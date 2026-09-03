import { describe, expect, test } from "vitest";

import { SKILL_TOOL_MAP } from "../src/agent/skills/skill-tool-map.js";
import { INITIAL_ACTIVE_TOOL_NAMES } from "../src/runtime/durable-agent-runtime.js";

/**
 * The runtime hardcodes which curated tools are active on the first model
 * turn, while SKILL_TOOL_MAP's dataset-construction entry is the curated
 * ownership list. They live in different modules; this guard fails when a
 * rename lands in one place only.
 */
describe("initial active tool names vs curated skill/tool map", () => {
  test("initially active tools are owned by the dataset-construction skill", () => {
    const datasetConstruction = SKILL_TOOL_MAP.find(
      (skill) => skill.name === "dataset-construction",
    );
    expect(datasetConstruction).toBeDefined();

    const owned = new Set(datasetConstruction?.tools ?? []);
    for (const name of INITIAL_ACTIVE_TOOL_NAMES) {
      expect(owned.has(name), `initial tool ${name} must be curated under dataset-construction`)
        .toBe(true);
    }
  });

  test("every dataset-construction core publication tool is either initial or on-demand", () => {
    // The publication pair plus route inspection must never depend on a
    // prior activate_agent_tools call: the completion contract in the system
    // prompt requires them before substantive acquisition.
    for (const required of [
      "inspect_dataset_execution_routes",
      "validate_dataset_execution",
      "execute_dataset_execution",
      "prepare_dynamic_family_publication",
      "submit_dynamic_family_publication",
    ]) {
      expect(INITIAL_ACTIVE_TOOL_NAMES).toContain(required);
    }
  });
});
