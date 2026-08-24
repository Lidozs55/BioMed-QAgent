/**
 * Stable Skill ↔ Tool name mapping (Phase 2).
 *
 * Single source of truth linking every curated `.pi/skills/<name>/SKILL.md`
 * entry to the tool names the Agent runtimes register. The legacy Python agent
 * registers the same operation names as direct tools; the Pi agent registers
 * `BioMedAgentTool` definitions with these names through the PiAgentAdapter
 * (see docs/migration/phase2-skills-tools-migration.md, decision D1/D5).
 *
 * Phase 5 migrates the business tool implementations to TypeScript; this map
 * is the contract those implementations are registered against. Phase 8
 * deletes the Python tool modules once parity is proven.
 */

export type SkillCategory =
  | "discovery"
  | "acquisition"
  | "processing"
  | "analysis";

export interface SkillToolMapping {
  /** `.pi/skills/<name>` directory and SKILL.md frontmatter name. */
  readonly name: string;
  readonly category: SkillCategory;
  /** Supported data-source identifiers (database selection UI and vetting). */
  readonly sources: readonly string[];
  /** One-sentence description of when the skill applies. */
  readonly description: string;
  /** Tool names the Agent runtimes register for this skill. */
  readonly tools: readonly string[];
}

function mapping(
  name: string,
  category: SkillCategory,
  sources: readonly string[],
  description: string,
  tools: readonly string[],
): SkillToolMapping {
  return Object.freeze({ name, category, sources, description, tools: Object.freeze([...tools]) });
}

export const SKILL_TOOL_MAP: readonly SkillToolMapping[] = Object.freeze([
  mapping(
    "pubmed",
    "discovery",
    ["pubmed", "ncbi"],
    "Search PubMed/NCBI for biomedical literature and download supplementary materials from PMC open-access articles.",
    ["search_pubmed", "download_supplementary"],
  ),
  mapping(
    "dbsnp",
    "discovery",
    ["dbsnp", "ncbi_variation"],
    "Look up verified RefSNP records by rsID through the official NCBI Variation API.",
    ["lookup_dbsnp"],
  ),
  mapping(
    "chembl",
    "discovery",
    ["chembl"],
    "Search the ChEMBL database for molecules (research-only; findings never route into dataset builds).",
    ["search_chembl"],
  ),
  mapping(
    "uniprot",
    "discovery",
    ["uniprot"],
    "Search the UniProt knowledgebase for protein entries (research-only; findings never route into dataset builds).",
    ["search_uniprot"],
  ),
  mapping(
    "literature_understanding",
    "discovery",
    ["pubmed", "crossref", "arxiv"],
    "Analyze paper titles to identify databases, accessions, data types, species, and retrieval queries.",
    ["analyze_papers"],
  ),
  mapping(
    "geo",
    "acquisition",
    ["geo", "ncbi_geo"],
    "Search, describe, and download GEO datasets, including platform annotations for probe-level builds.",
    [
      "search_geo",
      "describe_geo",
      "list_geo_supplementary_files",
      "download_geo",
      "download_geo_platform_annotation",
    ],
  ),
  mapping(
    "gdc",
    "acquisition",
    ["gdc", "tcga", "nci_gdc"],
    "Search, describe, and download NCI GDC datasets (TCGA, TARGET, CPTAC cancer genomics).",
    ["search_gdc", "describe_gdc", "download_gdc"],
  ),
  mapping(
    "xena",
    "acquisition",
    ["xena", "ucsc_xena"],
    "Search and download public genomics datasets from the UCSC Xena data hub.",
    ["search_xena", "download_xena"],
  ),
  mapping(
    "pdb",
    "acquisition",
    ["pdb", "rcsb_pdb"],
    "Search, describe, and download protein structures from RCSB PDB.",
    ["search_pdb", "describe_pdb", "download_pdb"],
  ),
  mapping(
    "pubchem",
    "acquisition",
    ["pubchem"],
    "Search and fetch chemical compound data from PubChem.",
    ["search_pubchem", "get_compound", "download_pubchem"],
  ),
  mapping(
    "reactome",
    "acquisition",
    ["reactome"],
    "Search and fetch biological pathway data from Reactome (research-only; findings never route into dataset builds).",
    ["search_reactome", "get_pathway", "download_reactome"],
  ),
  mapping(
    "browser",
    "acquisition",
    ["browser", "http", "web"],
    "Render and navigate public web pages and download files through verified content-addressed staging with guarded browser automation.",
    ["navigate_page", "download_from_page"],
  ),
  mapping(
    "local_cache",
    "acquisition",
    ["local_cache"],
    "Query the local cache for previously imported or cached datasets before searching external databases.",
    ["search_local_cache", "describe_local_cache", "get_cache_dataset"],
  ),
  mapping(
    "web_visual_capture",
    "acquisition",
    ["web_visual_capture", "visual_capture", "web"],
    "Capture web page screenshots for visual evidence and chart extraction on any public biomedical web page.",
    ["capture_web_page", "capture_page_section"],
  ),
  mapping(
    "pdf_extraction",
    "processing",
    ["pdf", "pubmed", "pmc"],
    "Extract tables and metadata from biomedical research PDFs into the task parsed directory.",
    ["extract_pdf_tables", "extract_pdf_metadata"],
  ),
  mapping(
    "extract_chart_data_vlm",
    "processing",
    ["extract_chart_data_vlm", "vlm", "chart_extraction"],
    "Extract structured chart data from paper figures or PDFs using the Qwen-VL visual model.",
    ["extract_chart_data_vlm"],
  ),
  mapping(
    "analysis",
    "analysis",
    ["csv", "tabular"],
    "Statistical analysis and visualization for tabular biomedical data (differential expression, heatmaps, correlation).",
    [
      "run_differential_expression",
      "generate_heatmap",
      "basic_statistics",
      "generate_correlation_matrix",
    ],
  ),
  mapping(
    "research_data_guidance",
    "analysis",
    [],
    "Load topic-specific research-data strategy and SOP guidance (data-source selection, cleaning, analyzability, provenance).",
    ["get_research_data_guidance"],
  ),
  mapping(
    "dataset-construction",
    "analysis",
    [],
    "Construct a DatasetBuild through the trusted Dataset Core boundary.",
    // Pi-side tool names. The legacy Python Agent registers the equivalent
    // pipeline tools as validate_dataset_build_spec / execute_dataset_build
    // (backend/app/pipeline/dataset_build_tool.py); Phase 5/8 converges on
    // these Pi names.
    ["validate_dataset_build", "execute_dataset_build", "submit_dynamic_family_build"],
  ),
]);

export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(
  SKILL_TOOL_MAP.flatMap((entry) => entry.tools),
);

export function toolOwner(toolName: string): string | undefined {
  for (const entry of SKILL_TOOL_MAP) {
    if (entry.tools.includes(toolName)) return entry.name;
  }
  return undefined;
}
