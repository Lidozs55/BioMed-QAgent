/**
 * `get_research_data_guidance` tool — topic-routed research-data SOP documents
 * (Python ``skills/builtin/analysis/research_data_guidance.py`` parity).
 *
 * Reads curated markdown from the shared guidance directory
 * (``.pi/skills/research_data_guidance/docs``); the Python package copy is a
 * mirror pinned byte-identical by backend/tests/test_skill_research_data_guidance.py
 * parity assertions — no second edited copy may drift.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BioMedAgentTool } from "../contracts.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const TOPIC_DOCS: Readonly<Record<string, string>> = {
  index: "科研数据策略指导（索引）",
  strategy: "研究问题 → 数据策略与设计",
  expression_omics: "表达谱与多组学数据",
  clinical: "临床与试验数据",
  structure_pathway_compound: "结构、通路与化合物",
  cleaning: "清洗、规范化与可分析性判定",
  reproducibility: "溯源、复现与报告",
};

const TOPIC_ALIASES: Readonly<Record<string, string>> = {
  "structure-pathway-compound": "structure_pathway_compound",
  structure_pathways: "structure_pathway_compound",
  "expression-omics": "expression_omics",
  "reproducibility-and-reporting": "reproducibility",
};

export function topicStem(topic: string): string {
  const key = (topic || "index").trim().toLowerCase();
  const stem = TOPIC_ALIASES[key] ?? key;
  return stem in TOPIC_DOCS ? stem : "index";
}

export interface ResearchDataGuidanceOptions {
  /** Curated guidance docs root (defaults to the repo .pi skills docs). */
  docsRoot?: string;
}

export async function loadResearchDataGuidance(
  topic: string,
  options: ResearchDataGuidanceOptions = {},
): Promise<string> {
  const stem = topicStem(topic);
  const docsRoot = options.docsRoot ?? defaultGuidanceDocsRoot();
  let text: string;
  try {
    text = await readFile(path.join(docsRoot, `${stem}.md`), "utf8");
  } catch {
    // Defensive (Python parity): a missing topic file is a packaging error —
    // surface the routing table rather than an empty result.
    text = await readFile(path.join(docsRoot, "index.md"), "utf8");
  }
  const header =
    `# ${TOPIC_DOCS[stem]}（research_data_guidance）\n\n` +
    `> 主题: ${stem} —— 如需其它主题，参考索引中的路由表。\n\n`;
  return header + text;
}

/** Resolve the curated guidance docs directory without hard-coding a cwd. */
export function defaultGuidanceDocsRoot(): string {
  // Repo layout: server/{src|dist}/agent/tools → ../../../.. → repo root.
  return path.resolve(MODULE_DIR, "..", "..", "..", "..", ".pi", "skills", "research_data_guidance", "docs");
}

export const GET_RESEARCH_DATA_GUIDANCE_TOOL_NAME = "get_research_data_guidance";

export function createResearchDataGuidanceTool(
  options: ResearchDataGuidanceOptions = {},
): BioMedAgentTool {
  return {
    name: GET_RESEARCH_DATA_GUIDANCE_TOOL_NAME,
    label: "Get research data guidance",
    description:
      "Load a topic-specific research-data guidance document for the current " +
      "task. Topics: 'strategy' (research question -> data sources & study " +
      "design), 'expression_omics' (RNA-seq/microarray/other omics data " +
      "acquisition), 'clinical' (cohort/EHR/trial data), " +
      "'structure_pathway_compound' (PDB/Reactome/PubChem research-only), " +
      "'cleaning' (entity mapping, units, analyzability diagnosis), " +
      "'reproducibility' (provenance, multi-source identity, publication). " +
      "Pass 'index' or an unknown topic to get the routing table. Read ONLY " +
      "the topic(s) relevant to the current task.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "One of: index, strategy, expression_omics, clinical, " +
            "structure_pathway_compound, cleaning, reproducibility. Unknown " +
            "topics fall back to the index (routing table).",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as { topic?: unknown };
      const topic = typeof record.topic === "string" ? record.topic : "index";
      return { content: await loadResearchDataGuidance(topic, options) };
    },
  };
}
