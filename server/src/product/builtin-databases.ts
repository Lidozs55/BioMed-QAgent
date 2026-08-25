/**
 * Builtin database catalogue — Phase 8.
 *
 * The builtin database metadata moved from Python
 * (``backend/app/skills/builtin`` → ``builtin_skill_records``) to TypeScript:
 * this module is the single source of truth for the user-selectable builtin
 * databases shown in the UI (literature, variation, safety, omics,
 * structure, chemistry, and pathway sources represented in SKILL_TOOL_MAP).
 *
 * Descriptions come from ``SKILL_TOOL_MAP`` (skill ↔ tool contract); the
 * Versions mirror the retired Python records. Pipeline support reflects the
 * current Core provider catalog, including task-scope Dynamic Family builds.
 * The enabled/disabled state is persisted by the Python DB bridge
 * (``database.database_store``) and passed in by the caller.
 */

import { SKILL_TOOL_MAP, type SkillCategory } from "../agent/skills/skill-tool-map.js";

export interface BuiltinDatabaseEntry {
  id: string;
  name: string;
  category: SkillCategory;
  description: string;
  origin: "builtin";
  version: string;
  pipeline_supported: boolean;
  capability: "pipeline_supported" | "research_only";
  available: boolean;
  enabled: boolean;
  declarative_manifest: null;
}

interface BuiltinDatabaseRecord {
  version: string;
  pipeline_supported: boolean;
}

/** Static facts for the selectable builtin databases. */
const BUILTIN_DATABASE_RECORDS: Record<string, BuiltinDatabaseRecord> = {
  pubmed: { version: "0.2.0", pipeline_supported: true },
  dbsnp: { version: "0.1.0", pipeline_supported: true },
  openfda: { version: "0.1.0", pipeline_supported: true },
  clinvar: { version: "0.1.0", pipeline_supported: true },
  mgnify: { version: "0.1.0", pipeline_supported: true },
  chembl: { version: "0.1.0", pipeline_supported: true },
  uniprot: { version: "0.1.0", pipeline_supported: true },
  geo: { version: "0.5.0", pipeline_supported: true },
  gdc: { version: "0.1.0", pipeline_supported: true },
  xena: { version: "0.1.0", pipeline_supported: true },
  pdb: { version: "0.1.0", pipeline_supported: true },
  pubchem: { version: "0.1.0", pipeline_supported: true },
  reactome: { version: "0.1.0", pipeline_supported: true },
};

/**
 * Mirrors the retired Python ``_NON_SELECTABLE_BUILTINS``: skills that exist
 * as agent capabilities but must not be user-selectable databases in the UI
 * (research aids, cache access, visual evidence, …).
 */
const NON_SELECTABLE_BUILTINS = new Set([
  "browser",
  "local_cache",
  "web_visual_capture",
  "literature_understanding",
  "pdf_extraction",
  "extract_chart_data_vlm",
  "analysis",
]);

export const BUILTIN_DATABASE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(BUILTIN_DATABASE_RECORDS),
);

function toEntry(
  mapping: (typeof SKILL_TOOL_MAP)[number],
  record: BuiltinDatabaseRecord,
  enabled: boolean,
): BuiltinDatabaseEntry {
  return {
    id: mapping.name,
    name: mapping.name,
    category: mapping.category,
    description: mapping.description,
    origin: "builtin",
    version: record.version,
    pipeline_supported: record.pipeline_supported,
    capability: record.pipeline_supported ? "pipeline_supported" : "research_only",
    available: true,
    enabled,
    declarative_manifest: null,
  };
}

/** All user-selectable builtin database entries (UI order, SKILL_TOOL_MAP). */
export function listBuiltinDatabases(
  disabled: ReadonlySet<string>,
): BuiltinDatabaseEntry[] {
  const entries: BuiltinDatabaseEntry[] = [];
  for (const mapping of SKILL_TOOL_MAP) {
    const record = BUILTIN_DATABASE_RECORDS[mapping.name];
    if (record === undefined) continue;
    if (NON_SELECTABLE_BUILTINS.has(mapping.name)) continue;
    if (mapping.sources.length === 0) continue;
    entries.push(toEntry(mapping, record, !disabled.has(mapping.name)));
  }
  return entries;
}

/** Look up one builtin database entry, or null for unknown/user names. */
export function getBuiltinDatabase(
  name: string,
  disabled: ReadonlySet<string>,
): BuiltinDatabaseEntry | null {
  const mapping = SKILL_TOOL_MAP.find((entry) => entry.name === name);
  if (mapping === undefined) return null;
  const record = BUILTIN_DATABASE_RECORDS[mapping.name];
  if (record === undefined) return null;
  if (NON_SELECTABLE_BUILTINS.has(mapping.name)) return null;
  if (mapping.sources.length === 0) return null;
  return toEntry(mapping, record, !disabled.has(mapping.name));
}
