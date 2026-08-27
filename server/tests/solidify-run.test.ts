import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  classifyStep,
  parameterizeArgs,
  parseFrontmatter,
  renderScriptCandidate,
  renderSkillCandidate,
  renderToolkitDoc,
  renderToolkitIndex,
  scanSkills,
  traceFlow,
} from "../../scripts/solidify-run.mjs";

const tempDirs: string[] = [];

async function fixtureDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "solidify-run-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function eventsForRun() {
  return [
    JSON.stringify({
      type: "run_started",
      run_id: "run-abc-123",
      sequence: 1,
      timestamp: "2026-08-19T01:00:00.000Z",
      payload: {},
    }),
    JSON.stringify({
      type: "tool_started",
      run_id: "run-abc-123",
      sequence: 2,
      timestamp: "2026-08-19T01:00:01.000Z",
      payload: {
        tool_call_id: "call-1",
        tool_name: "run_differential_expression",
        arguments: { csv_path: "data.csv", group_col: "Group", run_id: "x" },
      },
    }),
    JSON.stringify({
      type: "tool_completed",
      run_id: "run-abc-123",
      sequence: 3,
      timestamp: "2026-08-19T01:00:05.000Z",
      payload: { tool_call_id: "call-1", is_error: false },
    }),
    JSON.stringify({
      type: "tool_started",
      run_id: "run-abc-123",
      sequence: 4,
      timestamp: "2026-08-19T01:00:06.000Z",
      payload: {
        tool_call_id: "call-2",
        tool_name: "search_pubmed",
        arguments: { query: "BRCA1" },
      },
    }),
    JSON.stringify({
      type: "tool_completed",
      run_id: "run-abc-123",
      sequence: 5,
      timestamp: "2026-08-19T01:00:09.000Z",
      payload: { tool_call_id: "call-2", is_error: true },
    }),
    JSON.stringify({
      type: "run_completed",
      run_id: "run-abc-123",
      sequence: 6,
      timestamp: "2026-08-19T01:00:10.000Z",
      payload: {},
    }),
  ];
}

describe("classifyStep", () => {
  test("classifies deterministic local processing tools as replayable", () => {
    expect(classifyStep("run_differential_expression")).toBe("deterministic");
    expect(classifyStep("generate_heatmap")).toBe("deterministic");
    expect(classifyStep("basic_statistics")).toBe("deterministic");
    expect(classifyStep("extract_pdf_tables")).toBe("deterministic");
    expect(classifyStep("execute_dataset_execution")).toBe("deterministic");
    expect(classifyStep("get_research_data_guidance")).toBe("deterministic");
  });

  test("classifies acquisition tools as network/credential dependent", () => {
    expect(classifyStep("search_pubmed")).toBe("acquire");
    expect(classifyStep("download_geo")).toBe("acquire");
    expect(classifyStep("capture_web_page")).toBe("acquire");
    expect(classifyStep("extract_chart_data_vlm")).toBe("acquire");
    expect(classifyStep("analyze_papers")).toBe("acquire");
  });

  test("classifies unknown tools as skip", () => {
    expect(classifyStep(undefined)).toBe("skip");
    expect(classifyStep("some_private_tool")).toBe("skip");
  });
});

describe("parameterizeArgs", () => {
  test("keeps string and number keys, drops others", () => {
    const keys = parameterizeArgs({ csv_path: "a.csv", group_col: "Group", count: 5, flag: true, nested: { a: 1 } });
    expect(keys).toEqual(["csv_path", "group_col", "count"]);
  });

  test("returns empty for non-object inputs", () => {
    expect(parameterizeArgs(null)).toEqual([]);
    expect(parameterizeArgs("x")).toEqual([]);
  });
});

describe("traceFlow", () => {
  test("reconstructs ordered tool steps per run with completion and status", () => {
    const { flows, lastRunStatus } = traceFlow(eventsForRun());
    expect(lastRunStatus).toBe("completed");
    expect(flows).toHaveLength(1);
    const [run] = flows;
    expect(run.runId).toBe("run-abc-123");
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0].name).toBe("run_differential_expression");
    expect(run.steps[0].isError).toBe(false);
    expect(run.steps[0].seq).toBe(2);
    expect(run.steps[1].name).toBe("search_pubmed");
    expect(run.steps[1].isError).toBe(true);
    expect(run.deterministic.map((s) => s.name)).toEqual(["run_differential_expression"]);
    expect(run.acquire.map((s) => s.name)).toEqual(["search_pubmed"]);
  });

  test("ignores malformed lines and non-tool events", () => {
    const lines = ["not json", JSON.stringify({ type: "run_started", payload: {} })];
    const { flows, lastRunStatus } = traceFlow(lines);
    expect(flows).toEqual([]);
    expect(lastRunStatus).toBeNull();
  });
});

describe("renderScriptCandidate", () => {
  test("renders a replayable script containing deterministic tool names and placeholders", () => {
    const { flows } = traceFlow(eventsForRun());
    const script = renderScriptCandidate(flows[0], { taskId: "T1" });
    expect(script).toContain("replay-method");
    expect(script).toContain("run_differential_expression");
    expect(script).toContain("<csv_path>");
    expect(script).not.toContain("search_pubmed");
    expect(script).not.toMatch(/,,\n?/);
    expect(script.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});

describe("renderSkillCandidate", () => {
  test("renders frontmatter with name/description and tool lists", () => {
    const { flows } = traceFlow(eventsForRun());
    const candidate = renderSkillCandidate(flows[0], { taskId: "T1" });
    expect(candidate).toContain("name: t1");
    expect(candidate).toContain("`run_differential_expression`");
    expect(candidate).toContain("`search_pubmed`");
    expect(candidate).toContain("---");
  });
});

describe("parseFrontmatter", () => {
  test("extracts description and body from SKILL.md", () => {
    const parsed = parseFrontmatter(
      ['---', 'name: analysis', 'description: "Statistical tools."', "---", "", "# Body", "content"].join("\n"),
    );
    expect(parsed.description).toBe("Statistical tools.");
    expect(parsed.body).toContain("# Body");
  });

  test("returns raw text as body when frontmatter missing", () => {
    const parsed = parseFrontmatter("# nothing here");
    expect(parsed.description).toBe("");
    expect(parsed.body).toBe("# nothing here");
  });
});

describe("toolkit generation", () => {
  test("scanSkills + renderToolkitDoc produce standalone docs", async () => {
    const dir = await fixtureDir();
    const skillDir = path.join(dir, "analysis");
    await mkdir(skillDir);
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      ['---', "name: analysis", "description: Statistical tools.", "---", "", "# Analysis", "Use tools."].join("\n"),
    );

    const skills = await scanSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "analysis", slug: "analysis" });

    const doc = await renderToolkitDoc(skills[0].sourcePath, dir);
    expect(doc).toContain("# analysis");
    expect(doc).toContain("Statistical tools.");
    expect(doc).toContain("Use tools.");

    const index = renderToolkitIndex(skills);
    expect(index).toContain("analysis");
    expect(index).toContain("./analysis.md");
  });
});