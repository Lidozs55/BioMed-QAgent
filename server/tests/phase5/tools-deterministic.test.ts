/**
 * P5-02 deterministic tool tests: analyze_papers + research guidance.
 * Golden fixture parity against the Python implementation.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANALYZE_PAPERS_TOOL_NAME,
  analyzePapers,
  createAnalyzePapersTool,
  createBusinessToolBundle,
  createResearchDataGuidanceTool,
  GET_RESEARCH_DATA_GUIDANCE_TOOL_NAME,
  loadResearchDataGuidance,
  topicStem,
} from "../../src/agent/tools/index.js";
import { SKILL_TOOL_MAP, SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import { DuplicateToolNameError, assertUniqueToolNames } from "../../src/agent/tools/registry.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function golden(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")) as unknown;
}

describe("analyze_papers golden parity (Python-generated fixtures)", () => {
  const cases = [
    ["mixed", [
      "Integrated analysis of TCGA-BRCA and GSE12345 RNA-seq data reveals novel biomarkers",
      "ChIP-seq profiling of mouse embryonic stem cells (GSE99999, GSM1111111)",
      "A proteomics study deposited in PRIDE (PXD000001) of human plasma",
      "Structural basis of kinase inhibition (PDB 1ABC) with data at https://xena.ucsc.edu/datasets/x",
      "ArrayExpress E-MTAB-1234 metabolomics of rat liver",
      "dbGaP phs000178 whole genome sequencing of drosophila",
    ]],
    ["no_clues", ["No structured clues here", "A retrospective cohort study"]],
    ["empty_strings", ["", "   "]],
    ["empty", []],
  ] as const;

  it.each(cases)("matches %s.golden.json", async (name, titles) => {
    const result = analyzePapers(titles);
    expect(result).toEqual(await golden(`analyze_papers_${name}.golden.json`));
  });

  it("matches the empty-input shape exactly (no errors key)", async () => {
    const result = analyzePapers([]);
    expect(Object.keys(result).sort()).toEqual(["findings", "papers_analyzed", "summary"]);
    expect(result).toEqual(await golden("analyze_papers_empty.golden.json"));
  });

  it("routes non-string truthy titles into errors (Python AttributeError parity)", () => {
    const result = analyzePapers([5 as unknown as string, "ok title"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.error).toContain("has no attribute 'strip'");
    expect(result.papers_analyzed).toBe(1);
  });

  it("preserves Python truthiness quirks for falsy titles", () => {
    const result = analyzePapers([null as unknown as string]);
    expect(result.findings[0]).toEqual({
      title: "", // Python: _empty_finding("") — the original value is discarded
      databases_found: [],
      data_types: [],
      species: [],
      supplementary_links: [],
      keywords: [],
      query_suggestions: [],
    });
  });

  it("reports the QueryStatus hook (Python log_query parity)", () => {
    const calls: Array<[string, string, string, number]> = [];
    analyzePapers(["TCGA-BRCA study"], { onQuery: (q, s, st, n) => calls.push([q, s, st, n]) });
    expect(calls).toEqual([["analyze_papers", "literature_understanding", "success", 1]]);
  });
});

describe("analyze_papers tool registration", () => {
  it("registers under the SKILL_TOOL_MAP name", () => {
    expect(SKILL_TOOL_NAMES.has(ANALYZE_PAPERS_TOOL_NAME)).toBe(true);
    expect(toolOwner(ANALYZE_PAPERS_TOOL_NAME)).toBe("literature_understanding");
  });

  it("exposes the stable parameter schema", () => {
    const tool = createAnalyzePapersTool();
    expect(tool.parameters).toEqual({
      type: "object",
      properties: { titles: expect.objectContaining({ type: "array" }) },
      required: ["titles"],
      additionalProperties: false,
    });
  });

  it("executes through the BioMedAgentTool interface", async () => {
    const tool = createAnalyzePapersTool();
    const result = await tool.execute({ titles: ["TCGA-BRCA biomarkers"] });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { papers_analyzed: number };
    expect(parsed.papers_analyzed).toBe(1);
  });

  it("fails closed with isError on invalid input", async () => {
    const tool = createAnalyzePapersTool();
    const result = await tool.execute({ titles: "not-an-array" });
    expect(result.isError).toBe(true);
  });
});

describe("get_research_data_guidance parity", () => {
  it("routes every documented topic to its own stem", () => {
    for (const stem of ["index", "strategy", "expression_omics", "clinical", "structure_pathway_compound", "cleaning", "reproducibility"]) {
      expect(topicStem(stem)).toBe(stem);
    }
  });

  it("normalizes aliases (Python _TOPIC_ALIASES parity)", () => {
    expect(topicStem("structure-pathway-compound")).toBe("structure_pathway_compound");
    expect(topicStem("structure_pathways")).toBe("structure_pathway_compound");
    expect(topicStem("expression-omics")).toBe("expression_omics");
    expect(topicStem("reproducibility-and-reporting")).toBe("reproducibility");
    expect(topicStem("STRUCTURE_PATHWAYS")).toBe("structure_pathway_compound");
    expect(topicStem("  cleaning  ")).toBe("cleaning");
  });

  it("falls back to the index for unknown/empty topics", () => {
    expect(topicStem("does_not_exist")).toBe("index");
    expect(topicStem("")).toBe("index");
  });

  it("produces the Python header + curated document body", async () => {
    const doc = await loadResearchDataGuidance("cleaning");
    expect(doc.startsWith("# 清洗、规范化与可分析性判定（research_data_guidance）\n\n> 主题: cleaning —— 如需其它主题，参考索引中的路由表。\n\n")).toBe(true);
    expect(doc.length).toBeGreaterThan(500);
    expect(doc).toContain("cleaning");
  });

  it("index doc names every topic (Python test parity)", async () => {
    const doc = await loadResearchDataGuidance("index");
    for (const topic of ["strategy", "expression_omics", "clinical", "structure_pathway_compound", "cleaning", "reproducibility"]) {
      expect(doc).toContain(`\`${topic}\``);
    }
  });

  it("registers under the SKILL_TOOL_MAP name", () => {
    expect(SKILL_TOOL_NAMES.has(GET_RESEARCH_DATA_GUIDANCE_TOOL_NAME)).toBe(true);
    expect(toolOwner(GET_RESEARCH_DATA_GUIDANCE_TOOL_NAME)).toBe("research_data_guidance");
  });

  it("executes through the BioMedAgentTool interface", async () => {
    const tool = createResearchDataGuidanceTool();
    const result = await tool.execute({ topic: "strategy" });
    expect(result.content).toContain("research_data_guidance");
  });
});

describe("business tool bundle (P5-02/P5-12)", () => {
  it("registers the full curated tool set aligned with SKILL_TOOL_MAP", async () => {
    const bundle = await createBusinessToolBundle({
      taskRoot: "unused",
      browser: null,
      db: null,
    });
    const names = new Set(bundle.tools.map((tool) => tool.name));
    for (const name of names) {
      expect(SKILL_TOOL_NAMES.has(name), `tool ${name} must be in the skill map`).toBe(true);
      expect(toolOwner(name)).toBe(bundle.ownerOf(name));
    }
    // P5-12 registration rule: curated names == registered + unavailable.
    const expected = new Set([...SKILL_TOOL_NAMES].filter((name) => !["validate_dataset_execution", "execute_dataset_execution"].includes(name)));
    for (const name of expected) {
      expect(names.has(name) || bundle.unavailableTools.has(name), `tool ${name} missing from the bundle`).toBe(true);
    }
    // Browser-less/DB-less bundle marks the unavailable capability groups.
    // extract_registered_paper_chart_evidence is registry-gated: without the
    // task SourceAssetRegistry the governed promotion path is explicitly
    // unavailable instead of degrading to path-based inputs.
    expect(bundle.unavailableTools).toEqual(new Set([
      "navigate_page",
      "download_from_page",
      "capture_web_page",
      "capture_page_section",
      "search_local_cache",
      "describe_local_cache",
      "get_cache_dataset",
      "inspect_dataset_execution_routes",
      "prepare_dynamic_family_publication",
      "submit_dynamic_family_publication",
      "scaffold_dataset_execution_spec",
      "extract_registered_paper_chart_evidence",
    ]));
    // Analysis tools register with the full bundle.
    for (const name of [
      "run_differential_expression",
      "generate_heatmap",
      "basic_statistics",
      "generate_correlation_matrix",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("re-reads a dynamic runId for every analysis execution", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-tool-run-"));
    try {
      const csv = "gene_symbol,S1,S2\nTP53,1.5,2.5\nBRCA1,3.0,4.0\n";
      await writeFile(path.join(taskRoot, "input.csv"), csv, "utf8");
      let currentRunId = "run-first";
      const bundle = await createBusinessToolBundle({
        taskRoot,
        browser: null,
        db: null,
        runId: () => currentRunId,
      });
      const stats = bundle.tools.find((tool) => tool.name === "basic_statistics");
      expect(stats).toBeDefined();
      const first = await stats?.execute({ csv_path: "input.csv" });
      const firstPayload = JSON.parse(first?.content ?? "{}") as { stats_report?: string };
      expect(firstPayload.stats_report).toBe("staging/analysis/run-first/stats_report.csv");
      await readFile(path.join(taskRoot, "staging", "analysis", "run-first", "stats_report.csv"), "utf8");

      currentRunId = "run-second";
      const second = await stats?.execute({ csv_path: "input.csv" });
      const secondPayload = JSON.parse(second?.content ?? "{}") as { stats_report?: string };
      expect(secondPayload.stats_report).toBe("staging/analysis/run-second/stats_report.csv");
      await readFile(path.join(taskRoot, "staging", "analysis", "run-second", "stats_report.csv"), "utf8");
    } finally {
      await rm(taskRoot, { recursive: true, force: true });
    }
  });

  it("registers local cache tools when a DB bridge client is provided", async () => {
    const bundle = await createBusinessToolBundle({
      taskRoot: "unused",
      browser: null,
      db: {
        call: async () => [],
      } as unknown as Parameters<typeof createBusinessToolBundle>[0]["db"],
    });
    const names = new Set(bundle.tools.map((tool) => tool.name));
    expect(names.has("search_local_cache")).toBe(true);
    expect(names.has("describe_local_cache")).toBe(true);
    expect(names.has("get_cache_dataset")).toBe(true);
    expect(bundle.unavailableTools.has("search_local_cache")).toBe(false);
  });

  it("fails closed on duplicate tool names", () => {
    expect(() => assertUniqueToolNames([
      { name: "search_pubmed" },
      { name: "search_pubmed" },
    ])).toThrow(DuplicateToolNameError);
  });

  it("rejects invalid tool name shapes", () => {
    expect(() => assertUniqueToolNames([{ name: "Bad-Name" }])).toThrow(TypeError);
  });

  it("keeps Pi imports out of the bundle module", async () => {
    // Pi types are confined to the adapter layer (migration plan constraint).
    const source = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "agent", "tools", "business-tools.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/pi-coding-agent|pi-adapter/);
  });

  it("every curated SKILL_TOOL_MAP tool name is owned by exactly one skill", () => {
    const map = new Map<string, string[]>();
    for (const entry of SKILL_TOOL_MAP) {
      if (entry.guidance_only === true) continue;
      for (const tool of entry.tools) {
        map.set(tool, [...(map.get(tool) ?? []), entry.name]);
      }
    }
    for (const [tool, owners] of map) {
      expect(owners, `tool ${tool} must have a single operational owner`).toHaveLength(1);
    }
  });
});
