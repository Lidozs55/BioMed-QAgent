import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  SKILL_TOOL_MAP,
  SKILL_TOOL_NAMES,
  type SkillToolMapping,
} from "../src/agent/skills/skill-tool-map.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const skillsRoot = path.join(repositoryRoot, ".pi", "skills");

/**
 * Non-tool identifiers that may legitimately appear in backticks inside a
 * SKILL.md body (tool parameter names, schema field names). Everything else
 * backtick-quoted and snake-case must resolve to a mapped tool name.
 */
const ALLOWED_BACKTICK_TOKENS = new Set([
  "source_files",
  "mapping_files",
  "metadata_files",
  // schema namespaces / build result identifiers / real tools referenced by guidance
  "geo_probe",
  "no_data",
  "no_primary_data",
  "retryable",
  "workspace_exec",
  // route preflight route_status value (schema field, not a tool)
  "requires_formal_extraction",
  // static family id referenced by guidance (registry identifier, not a tool)
  "gut_microbiome",
  // fixed-provider acquisition request parameter names (not tools)
  "source",
  "accession",
  "entities",
  // browser navigate_page request parameter names (not tools)
  "max_chars",
  "offset",
  "archive_html",
  // entity/schema field names, declared input roles, and adapter ids
  // referenced by dataset-construction guidance (identifiers, not tools)
  "csv_data",
  "mgnify_study_data",
  "disease_id",
  "disease_name",
  "host_taxon_id",
  "input_requirement_ref",
  "registered_gut_microbiome_study_json",
  "study_accession",
  "study_id",
  // acquisition-only carrier route referenced by dataset-construction guidance;
  // registered contextually by the dynamic-family toolset, not a curated bundle entry
  "acquire_core_carrier",
  // governed Core archive-member extraction tool (core-asset-tools); referenced
  // by extract_chart_data_vlm guidance for ZIP supplementary member registration
  "extract_core_archive",
  // governed Core asset preview tool (core-asset-tools); referenced by
  // extract_chart_data_vlm guidance for listing ZIP supplementary members
  "preview_core_asset",
  // extract_registered_paper_chart_evidence request parameter name (field, not a tool)
  "supplementary_asset_ids",
]);

const SKILL_NAME = /^[a-z][a-z0-9_-]*$/;

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error("SKILL.md must start with YAML frontmatter (---)");
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("SKILL.md frontmatter is not closed");
  const fields: SkillFrontmatter = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    fields[match[1] as keyof SkillFrontmatter] = match[2]!.trim();
  }
  return fields;
}

function referencedToolTokens(body: string): string[] {
  const tokens = new Set<string>();
  for (const match of body.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
    tokens.add(match[1]!);
  }
  return [...tokens];
}

async function listSkillDirectories(): Promise<string[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function readSkill(directory: string): Promise<{
  directory: string;
  content: string;
  frontmatter: SkillFrontmatter;
  body: string;
}> {
  const file = path.join(skillsRoot, directory, "SKILL.md");
  const content = await readFile(file, "utf8");
  const lines = content.split(/\r?\n/);
  const end = lines.indexOf("---", 1);
  return {
    directory,
    content,
    frontmatter: parseFrontmatter(content),
    body: lines.slice(end + 1).join("\n"),
  };
}

describe(".pi/skills manifest integrity", () => {
  test("the skills root exists and contains the migrated skills", async () => {
    const info = await stat(skillsRoot);
    expect(info.isDirectory()).toBe(true);
    const directories = await listSkillDirectories();
    expect(directories.length).toBeGreaterThanOrEqual(18);
  });

  test("every skill directory has a valid SKILL.md whose name matches the directory", async () => {
    for (const directory of await listSkillDirectories()) {
      const skill = await readSkill(directory);
      expect(skill.directory, skill.directory).toMatch(SKILL_NAME);
      expect(skill.frontmatter.name, skill.directory).toBe(skill.directory);
      expect(
        (skill.frontmatter.description ?? "").length,
        skill.directory,
      ).toBeGreaterThan(0);
      expect(skill.frontmatter.description ?? "", skill.directory).not.toContain("\n");
      expect(skill.body.trim().length, skill.directory).toBeGreaterThan(0);
    }
  });

  test("every SKILL.md frontmatter name exists in the stable skill ↔ tool map", async () => {
    const mapped = new Map(SKILL_TOOL_MAP.map((entry) => [entry.name, entry]));
    for (const directory of await listSkillDirectories()) {
      const skill = await readSkill(directory);
      expect(mapped.has(skill.directory), skill.directory).toBe(true);
    }
  });

  test("every skill in the map has a SKILL.md on disk", async () => {
    const directories = new Set(await listSkillDirectories());
    for (const entry of SKILL_TOOL_MAP) {
      expect(directories.has(entry.name), entry.name).toBe(true);
    }
  });

  test("no SKILL.md references phantom tools (find_skill / invoke_skill / unknown names)", async () => {
    for (const directory of await listSkillDirectories()) {
      const skill = await readSkill(directory);
      for (const token of referencedToolTokens(skill.body)) {
        expect(
          SKILL_TOOL_NAMES.has(token) ||
            ALLOWED_BACKTICK_TOKENS.has(token) ||
            token === skill.directory,
          `${skill.directory} references unknown tool \`${token}\``,
        ).toBe(true);
      }
    }
  });

  test("every SKILL.md body references at least one of its mapped tools", async () => {
    const mapped = new Map<string, SkillToolMapping>(
      SKILL_TOOL_MAP.map((entry) => [entry.name, entry]),
    );
    for (const directory of await listSkillDirectories()) {
      const skill = await readSkill(directory);
      const mapping = mapped.get(skill.directory);
      expect(mapping, skill.directory).toBeDefined();
      const tokens = new Set(referencedToolTokens(skill.body));
      const covered = (mapping?.tools ?? []).filter((tool) => tokens.has(tool));
      expect(covered.length, `${skill.directory} must reference its own tools`).toBeGreaterThan(0);
    }
  });

  test("descriptions are concise and single-purpose", async () => {
    for (const directory of await listSkillDirectories()) {
      const skill = await readSkill(directory);
      expect((skill.frontmatter.description ?? "").length).toBeLessThanOrEqual(300);
    }
  });

  test("dataset-construction documents the dynamic prepare/submit receipt protocol", async () => {
    const skill = await readSkill("dataset-construction");
    expect(skill.body).toMatch(/prepare_dynamic_family_publication/);
    expect(skill.body).toMatch(/Host descriptor digest[\s\S]*server-bound/i);
    expect(skill.body).toMatch(/Host[\s\S]*(?:retains|retrieves)[\s\S]*prepared submission/i);
    expect(skill.body).toMatch(/pass only[\s\S]*preflight receipt/i);
    expect(skill.body).toMatch(/unchanged receipt/i);
    expect(skill.body).toMatch(/fresh prepare[\s\S]*(?:source|projection|transform)[\s\S]*change/i);
  });

  test("dataset-construction never bypasses prepare after a committed fact change", async () => {
    const skill = await readSkill("dataset-construction");
    expect(skill.body).toMatch(/switch immediately to\s+the fixed dynamic\s+protocol/i);
    const recoveryStep = skill.body.slice(skill.body.indexOf("6. Treat a failed"));
    expect(recoveryStep).toMatch(/fixed dynamic\s+protocol/i);
    const prepare = recoveryStep.indexOf("prepare_dynamic_family_publication");
    const submit = recoveryStep.indexOf("submit_dynamic_family_publication", prepare);
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(submit).toBeGreaterThan(prepare);
    expect(recoveryStep).toMatch(
      /prepare_dynamic_family_publication[\s\S]*submit_dynamic_family_publication[\s\S]*only its unchanged receipt[\s\S]*Host[\s\S]*prepared submission/i,
    );
    expect(recoveryStep).not.toMatch(/switch immediately to\s+\n?\s*`submit_dynamic_family_publication`/i);
  });

  test("dataset construction stays source-neutral while source skills own provider rules", async () => {
    const dataset = await readSkill("dataset-construction");
    for (const sourceSpecificRule of [
      "pubmed.files.v1",
      "chembl.files.v1",
      "pubchem.files.v1",
      "probe-to-gene",
    ]) {
      expect(dataset.body, sourceSpecificRule).not.toContain(sourceSpecificRule);
    }

    expect((await readSkill("pubmed")).body).toContain("pubmed.files.v1");
    expect((await readSkill("chembl")).body).toContain("chembl.files.v1");
    expect((await readSkill("pubchem")).body).toContain("pubchem.files.v1");
    expect((await readSkill("geo")).body).toMatch(/probe-(?:to-gene|level)/i);

    const pubmed = await readSkill("pubmed");
    for (const tableId of [
      "paper_records",
      "experiment_records",
      "activity_value_records",
      "chart_series",
      "chart_points",
      "supplementary_asset_records",
    ]) {
      expect(pubmed.body).toContain(tableId);
    }
    expect(pubmed.body).toMatch(/exact published chart coordinates/i);
    expect(pubmed.body).toMatch(
      /article tables[\s\S]*supplement[\s\S]*official publisher[\s\S]*author-declared repository/i,
    );
    expect(pubmed.body).toMatch(/do not digitize[\s\S]*raster[\s\S]*vector geometry/i);
    expect(pubmed.body).toMatch(/publish the[\s\S]*independently exact records/i);
    expect(pubmed.body).toMatch(/contact the authors/i);
    expect(dataset.body).toMatch(/descriptor digest is\s+server-bound/i);
    expect(dataset.body).toMatch(/do not repeat a failure-driven descriptor handshake/i);
  });

  test("chart extraction names the registered promotion path and bounds the exploratory tool", async () => {
    const mapping = new Map(SKILL_TOOL_MAP.map((entry) => [entry.name, entry]))
      .get("extract_chart_data_vlm");
    expect(mapping).toBeDefined();
    expect(mapping?.tools).toContain("extract_chart_data_vlm");
    expect(mapping?.tools).toContain("extract_registered_paper_chart_evidence");

    const skill = await readSkill("extract_chart_data_vlm");
    expect(skill.body).toContain("extract_registered_paper_chart_evidence");
    expect(skill.body).toMatch(/only\s+`extract_registered_paper_chart_evidence`/i);
    expect(skill.body).toMatch(/cannot publish/i);
    expect(skill.body).toMatch(/exploratory/i);
    expect(skill.body).toMatch(/exact-only/i);
    expect(skill.body).toMatch(/estimated-point[\s\S]*deprecated/i);
    expect(skill.body).toMatch(/human review cannot[\s\S]*exact/i);
    expect(skill.body).toMatch(/estimated rows[\s\S]*point-level review[\s\S]*Reject\/skip/i);
    expect(skill.body).toMatch(/never bind its candidate or[\s\S]*reviewed carrier/i);
    expect(skill.body).toMatch(/bind a registered VLM carrier[\s\S]*only[\s\S]*chart_points[\s\S]*empty/i);
    expect(skill.body).toMatch(/Future non-empty exact points[\s\S]*numeric source-data carrier/i);
    expect(skill.body).toMatch(/search for an\s+explicit numeric source/i);
  });

  test("Gold6 closure guidance: frozen context is semantics, blockers replace workspace CSV", async () => {
    const dataset = await readSkill("dataset-construction");
    // The frozen execution context binds task semantics for a run but never
    // grants publication authority or bypasses the protocol.
    expect(dataset.body).toMatch(/frozen evaluation context/i);
    expect(dataset.body).toMatch(/binding task semantics/i);
    expect(dataset.body).toMatch(/never\s+publication\s+authority/i);
    expect(dataset.body).toMatch(/current-run immutable Publication/i);

    const chart = await readSkill("extract_chart_data_vlm");
    expect(chart.body).toMatch(/frozen execution context/i);
    expect(chart.body).toMatch(/never publication authority/i);
    // Discovery failures remain structured, but an estimated-point review is
    // rejected/skipped rather than becoming a publication prerequisite.
    expect(chart.body).toMatch(
      /If a required carrier, the visual model, or a usable page locator is\s+unavailable, return the structured discovery blocker/i,
    );
    expect(chart.body).toMatch(/Point-level review is not required[\s\S]*no exact source exists/i);
    expect(chart.body).toMatch(/workspace\s+CSV/);
  });
});
