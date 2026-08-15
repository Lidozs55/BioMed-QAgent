/**
 * `analyze_papers` tool — deterministic literature-understanding port
 * (Python ``skills/builtin/discovery/understanding.py`` parity).
 *
 * Regex-based extraction from paper titles only: database names, accessions,
 * data types, species, keywords, supplementary links, query suggestions.
 * No network, no model calls. Behavior — including the naive substring
 * species matching and database-name-driven accession extraction — is pinned
 * by golden fixtures generated from the Python implementation
 * (server/tests/phase5/fixtures/analyze_papers_*.golden.json).
 */

import type { BioMedAgentTool } from "../contracts.js";

export interface AnalyzePapersHooks {
  /** Query lifecycle start (operation_started parity). */
  onQueryStarted?: (query: string, source: string) => void;
  /** QueryStatus projection (Python run_ctx.log_query parity). */
  onQuery?: (query: string, source: string, status: string, recordsCount: number) => void;
}

const DATA_TYPES = [
  "RNA-seq", "microarray", "ChIP-seq", "WGS", "WES",
  "scRNA-seq", "proteomics", "metabolomics", "methylation",
  "ATAC-seq", "single-cell RNA-seq",
] as const;

const SPECIES = [
  "human", "mouse", "rat", "zebrafish", "drosophila",
  "c. elegans", "yeast", "fruit fly", "arabidopsis",
] as const;

const KEYWORDS = [
  "deposited in", "available at", "accession number",
  "GEO accession", "supplementary data", "supplementary material",
] as const;

const URL_PATTERN = /https?:\/\/\S+/;

const SUPPLEMENTARY_MARKERS = [
  "supplement", "supplementary", "data portal", "github",
  "geo", "gdc", "tcga", "xena", "ega", "pride",
  "metabolights", "arrayexpress",
] as const;

function extractAll(text: string, pattern: RegExp): string[] {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
  return matches === null ? [] : [...new Set(matches)];
}

function findSpecies(text: string): string[] {
  const lower = text.toLowerCase();
  return [...new Set(SPECIES.filter((species) => lower.includes(species.toLowerCase())))];
}

function findDataTypes(text: string): string[] {
  const lower = text.toLowerCase();
  return [...new Set(DATA_TYPES.filter((type) => lower.includes(type.toLowerCase())))];
}

function findKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return [...new Set(KEYWORDS.filter((keyword) => lower.includes(keyword.toLowerCase())))];
}

function findSupplementaryLinks(text: string): string[] {
  return extractAll(text, URL_PATTERN).filter((url) =>
    SUPPLEMENTARY_MARKERS.some((marker) => url.toLowerCase().includes(marker)),
  );
}

// Python _ACCESSION_PATTERNS_BY_DB, ordered by the db_names iteration order.
const DATABASE_NAMES = [
  "GEO", "GDC", "TCGA", "Xena", "PDB", "ArrayExpress",
  "SRA", "EGA", "dbGaP", "PRIDE", "MetaboLights",
] as const;

const ACCESSION_PATTERNS_BY_DB: Readonly<Record<string, RegExp>> = {
  GEO: /\b(GSE\d{4,}|GSM\d{4,}|GPL\d{4,})\b/,
  GDC: /\bGDC_\w+\b/,
  TCGA: /\b(TCGA-[A-Z0-9]{2,}-[A-Z0-9]+)\b/,
  Xena: /\bhttps?:\/\/\S*?xena\S*?\.(?:net|org)\b/i,
  PDB: /\b[0-9][A-Za-z0-9]{3}\b/,
  ArrayExpress: /\bE-MTAB-\d+\b/,
  SRA: /\bSR[APX]\d{6,}\b/,
  EGA: /\b(EGAD\d+|EGAS\d+)\b/,
  dbGaP: /\bphs\d+\b/,
  PRIDE: /\b(PXD\d+|PRIDE-\d+)\b/,
  MetaboLights: /\bMTBLS\d+\b/,
};

export interface DatabaseFinding {
  name: string;
  accessions: string[];
  confidence: "high" | "medium";
}

export interface PaperFinding {
  title: unknown;
  databases_found: DatabaseFinding[];
  data_types: string[];
  species: string[];
  supplementary_links: string[];
  keywords: string[];
  query_suggestions: string[];
}

function emptyFinding(title: unknown): PaperFinding {
  return {
    title,
    databases_found: [],
    data_types: [],
    species: [],
    supplementary_links: [],
    keywords: [],
    query_suggestions: [],
  };
}

function analyzeTitle(title: unknown): PaperFinding {
  // Python: combined = (title or "").strip() — Python truthiness decides:
  // falsy titles (None/0/"") yield an empty finding with the original value;
  // truthy non-strings raise AttributeError into the errors array.
  let combined: string;
  if (!title) {
    combined = "";
  } else if (typeof title !== "string") {
    throw new TypeError(`'${typeof title}' object has no attribute 'strip'`);
  } else {
    combined = title.trim();
  }
  if (combined === "") return emptyFinding(""); // Python: _empty_finding("") — literal empty string

  const databasesFound: DatabaseFinding[] = [];
  for (const dbName of DATABASE_NAMES) {
    const namePattern = new RegExp(`\\b${dbName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (namePattern.test(combined)) {
      const accessions = extractAll(combined, ACCESSION_PATTERNS_BY_DB[dbName]);
      databasesFound.push({ name: dbName, accessions, confidence: accessions.length > 0 ? "high" : "medium" });
    }
  }

  const suggestions: string[] = [];
  for (const database of databasesFound) {
    suggestions.push(...database.accessions.slice(0, 2));
  }
  suggestions.push(...findKeywords(combined));
  const querySuggestions = [...new Set(suggestions)].slice(0, 10);

  return {
    title: title as string | null,
    databases_found: databasesFound,
    data_types: findDataTypes(combined),
    species: findSpecies(combined),
    supplementary_links: findSupplementaryLinks(combined),
    keywords: findKeywords(combined),
    query_suggestions: querySuggestions,
  };
}

export interface AnalyzePapersResult {
  papers_analyzed: number;
  findings: PaperFinding[];
  /** Present on the main path only; the empty-input early return omits it (Python parity). */
  errors?: Array<{ title: unknown; error: string }>;
  summary: {
    databases_referenced: string[];
    total_accessions_found: number;
    primary_data_types: string[];
  };
}

export function analyzePapers(titles: unknown, hooks: AnalyzePapersHooks = {}): AnalyzePapersResult {
  if (!Array.isArray(titles)) {
    throw new TypeError("titles must be an array");
  }
  hooks.onQueryStarted?.("analyze_papers", "literature_understanding");
  if (titles.length === 0) {
    return {
      papers_analyzed: 0,
      findings: [],
      // Python parity: the empty-input early return has no "errors" key.
      summary: {
        databases_referenced: [],
        total_accessions_found: 0,
        primary_data_types: [],
      },
    };
  }

  const findings: PaperFinding[] = [];
  const allDatabases: string[] = [];
  const allAccessions: string[] = [];
  const allDataTypes: string[] = [];
  const errors: Array<{ title: unknown; error: string }> = [];

  for (const title of titles) {
    let finding: PaperFinding;
    try {
      finding = analyzeTitle(title);
    } catch (error) {
      errors.push({ title, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    findings.push(finding);
    for (const database of finding.databases_found) {
      allDatabases.push(database.name);
      allAccessions.push(...database.accessions);
    }
    allDataTypes.push(...finding.data_types);
  }

  hooks.onQuery?.("analyze_papers", "literature_understanding", "success", findings.length);

  return {
    papers_analyzed: findings.length,
    findings,
    errors,
    summary: {
      databases_referenced: [...new Set(allDatabases)],
      total_accessions_found: allAccessions.length,
      primary_data_types: [...new Set(allDataTypes)],
    },
  };
}

export const ANALYZE_PAPERS_TOOL_NAME = "analyze_papers";

export function createAnalyzePapersTool(hooks: AnalyzePapersHooks = {}): BioMedAgentTool {
  return {
    name: ANALYZE_PAPERS_TOOL_NAME,
    label: "Analyze paper titles",
    description:
      "Analyze paper titles to extract structured data clues: database names, " +
      "accession numbers, data types, species, and query suggestions. " +
      "Input is a list of title strings. Returns structured JSON with findings " +
      "per paper plus a cross-paper summary. Only pass titles — do NOT pass " +
      "abstracts, authors, or other fields.",
    parameters: {
      type: "object",
      properties: {
        titles: {
          type: "array",
          items: { type: "string" },
          description: "List of paper title strings. Only titles — no abstracts or other fields.",
        },
      },
      required: ["titles"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as { titles?: unknown };
      try {
        return { content: JSON.stringify(analyzePapers(record.titles, hooks)) };
      } catch (error) {
        return {
          content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          isError: true,
        };
      }
    },
  };
}
