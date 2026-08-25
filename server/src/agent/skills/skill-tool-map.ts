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
  /** Concise planning-time route and trust-boundary guidance. */
  readonly routing: string;
  /** Tool names the Agent runtimes register for this skill. */
  readonly tools: readonly string[];
}

function mapping(
  name: string,
  category: SkillCategory,
  sources: readonly string[],
  description: string,
  routing: string,
  tools: readonly string[],
): SkillToolMapping {
  return Object.freeze({
    name,
    category,
    sources,
    description,
    routing,
    tools: Object.freeze([...tools]),
  });
}

export const SKILL_TOOL_MAP: readonly SkillToolMapping[] = Object.freeze([
  mapping(
    "pubmed",
    "discovery",
    ["pubmed", "ncbi"],
    "Search PubMed/NCBI for biomedical literature and download supplementary materials from PMC open-access articles.",
    "Use for literature and supplementary discovery. Search, supplementary, PDF, and workspace bytes are preparation only; formal open-access full text uses one verified PMCID per binding through Core provider pubmed.files.v1.",
    ["search_pubmed", "download_supplementary"],
  ),
  mapping(
    "dbsnp",
    "discovery",
    ["dbsnp", "ncbi_variation"],
    "Look up verified RefSNP records by rsID through the official NCBI Variation API.",
    "Use to verify rsIDs, placements, and alleles. Results are discovery evidence only, not a formal Core carrier or a dataset family/provider; failed records remain unavailable.",
    ["lookup_dbsnp"],
  ),
  mapping(
    "openfda",
    "discovery",
    ["openfda", "faers"],
    "Look up exact MedDRA reaction counts from official openFDA FAERS aggregates.",
    "Use for retrieval-time FAERS reaction counts. Counts are not deduplicated patients or causal evidence and are discovery-only until a registered drug-safety family/provider exists.",
    ["lookup_openfda_dili_counts"],
  ),
  mapping(
    "clinvar",
    "discovery",
    ["clinvar", "ncbi"],
    "Look up total and pathogenic ClinVar variant counts for verified gene symbols.",
    "Use for gene-level count summaries after symbol verification. Counts do not replace variant records and are discovery-only unless a matching registered family/provider closes formal acquisition.",
    ["lookup_clinvar_counts"],
  ),
  mapping(
    "mgnify",
    "discovery",
    ["mgnify", "metagenomics"],
    "Search official MGnify study metadata through its JSON API without browser rendering.",
    "Use to discover study metadata and accessions. Metadata contains no abundance or association estimates; formal microbiome output requires evidence-bound tables and a registered family/provider.",
    ["search_mgnify_studies"],
  ),
  mapping(
    "chembl",
    "discovery",
    ["chembl"],
    "Search the ChEMBL database for molecules (research-only; findings never route into dataset builds).",
    "Use search results only to discover controlled ChEMBL IDs. Formal bioactivity bytes must be reacquired by Dataset Core through chembl.files.v1; never use search or workspace responses as carriers.",
    ["search_chembl"],
  ),
  mapping(
    "uniprot",
    "discovery",
    ["uniprot"],
    "Search the UniProt knowledgebase for protein entries (research-only; findings never route into dataset builds).",
    "Use to ground protein accessions and terminology during research. Current UniProt tool output is research-only and must not be declared as a formal dataset build source.",
    ["search_uniprot"],
  ),
  mapping(
    "literature_understanding",
    "discovery",
    ["pubmed", "crossref", "arxiv"],
    "Analyze paper titles to identify databases, accessions, data types, species, and retrieval queries.",
    "Use after literature discovery and pass titles only. Its suggestions route to matching source tools but are neither source evidence nor formal build carriers.",
    ["analyze_papers"],
  ),
  mapping(
    "geo",
    "acquisition",
    ["geo", "ncbi_geo"],
    "Search, describe, and download GEO datasets, including platform annotations for probe-level builds.",
    "Vetting with describe_geo is mandatory before build. Probe-level sources need declared semantics and probe-to-gene annotation for gene-level output; otherwise use probe granularity or another real source.",
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
    "Use for vetted cancer-genomics cohorts. Build each cohort and family separately through the registered GDC adapter/provider path; downloaded files alone are not a Publication.",
    ["search_gdc", "describe_gdc", "download_gdc"],
  ),
  mapping(
    "xena",
    "acquisition",
    ["xena", "ucsc_xena"],
    "Search and download public genomics datasets from the UCSC Xena data hub.",
    "Use for specific public-hub matrices after discovery. Build each cohort and family separately through the registered Xena adapter/provider path; workspace files remain staging.",
    ["search_xena", "download_xena"],
  ),
  mapping(
    "pdb",
    "acquisition",
    ["pdb", "rcsb_pdb"],
    "Search, describe, and download protein structures from RCSB PDB.",
    "Use for structure discovery and traceable downloads. The current skill marks Agent PDB outputs research-only; do not declare them as a formal build carrier without a registered Core route.",
    ["search_pdb", "describe_pdb", "download_pdb"],
  ),
  mapping(
    "pubchem",
    "acquisition",
    ["pubchem"],
    "Search and fetch chemical compound data from PubChem.",
    "Use to discover and verify exact positive CIDs. Formal compound identity must be reacquired by Core through pubchem.files.v1 and crosswalked by exact InChIKey, never by name alone.",
    ["search_pubchem", "get_compound", "download_pubchem"],
  ),
  mapping(
    "reactome",
    "acquisition",
    ["reactome"],
    "Search and fetch biological pathway data from Reactome (research-only; findings never route into dataset builds).",
    "Use for pathway discovery, participants, and stable IDs. Current Reactome outputs are research-only and must not be declared as formal dataset build sources.",
    ["search_reactome", "get_pathway", "download_reactome"],
  ),
  mapping(
    "browser",
    "acquisition",
    ["browser", "http", "web"],
    "Render and navigate public web pages and download files through verified content-addressed staging with guarded browser automation.",
    "Use for public-page research or known downloads. Browser-acquired text and files are staging evidence only and must never be substituted for a registered Core carrier.",
    ["navigate_page", "download_from_page"],
  ),
  mapping(
    "local_cache",
    "acquisition",
    ["local_cache"],
    "Query the local cache for previously imported or cached datasets before searching external databases.",
    "Use early to discover reusable prior data, then inspect identity and provenance. Cache hits are research aids and do not replace a new trusted Core build and Publication.",
    ["search_local_cache", "describe_local_cache", "get_cache_dataset"],
  ),
  mapping(
    "web_visual_capture",
    "acquisition",
    ["web_visual_capture", "visual_capture", "web"],
    "Capture web page screenshots for visual evidence and chart extraction on any public biomedical web page.",
    "Use when visual provenance or chart input is genuinely needed. Screenshots do not replace structured APIs and remain preparation evidence until a reviewed Core build binds them.",
    ["capture_web_page", "capture_page_section"],
  ),
  mapping(
    "pdf_extraction",
    "processing",
    ["pdf", "pubmed", "pmc"],
    "Extract tables and metadata from biomedical research PDFs into the task parsed directory.",
    "Use on acquired PDFs for bounded extraction. Parsed CSV and metadata are preparation material, not formal artifacts or registered Core carriers.",
    ["extract_pdf_tables", "extract_pdf_metadata"],
  ),
  mapping(
    "extract_chart_data_vlm",
    "processing",
    ["extract_chart_data_vlm", "vlm", "chart_extraction"],
    "Extract structured chart data from paper figures or PDFs using the Qwen-VL visual model.",
    "Use only for genuine charts or figures. Outputs are staging; estimated or uncertain points require evidence-bound human review before any formal publication.",
    ["extract_chart_data_vlm"],
  ),
  mapping(
    "analysis",
    "analysis",
    ["csv", "tabular"],
    "Statistical analysis and visualization for tabular biomedical data (differential expression, heatmaps, correlation).",
    "Use after checking rows, groups, and units. Analysis outputs do not create or replace a formal Dataset Core Publication, and every reported method must remain explicit.",
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
    "Use before source selection or integration when domain strategy is needed. Load only relevant topics; guidance informs planning but does not acquire evidence or publish datasets.",
    ["get_research_data_guidance"],
  ),
  mapping(
    "dataset-construction",
    "analysis",
    [],
    "Construct a DatasetBuild through the trusted Dataset Core boundary.",
    "Required for dataset, CSV, table, or multi-source record outputs. Split by semantic family and row granularity, validate before execute, use dynamic family submission for unsupported topology, and treat only Publication as formal success.",
    // Pi-side tool names. The legacy Python Agent registers the equivalent
    // pipeline tools as validate_dataset_build_spec / execute_dataset_build
    // (backend/app/pipeline/dataset_build_tool.py); Phase 5/8 converges on
    // these Pi names.
    [
      "validate_dataset_build",
      "execute_dataset_build",
      "prepare_dynamic_family_build",
      "submit_dynamic_family_build",
    ],
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
