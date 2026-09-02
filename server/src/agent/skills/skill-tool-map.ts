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
  /**
   * Guidance-only skills teach routes over tools owned by operational skills;
   * toolOwner() skips them so every tool keeps exactly one operational owner.
   */
  readonly guidance_only?: boolean;
}

function mapping(
  name: string,
  category: SkillCategory,
  sources: readonly string[],
  description: string,
  routing: string,
  tools: readonly string[],
  options: { readonly guidanceOnly?: boolean } = {},
): SkillToolMapping {
  return Object.freeze({
    name,
    category,
    sources,
    description,
    routing,
    tools: Object.freeze([...tools]),
    ...(options.guidanceOnly ? { guidance_only: true as const } : {}),
  });
}

export const SKILL_TOOL_MAP: readonly SkillToolMapping[] = Object.freeze([
  mapping(
    "pubmed",
    "discovery",
    ["pubmed", "ncbi"],
    "Search PubMed/NCBI for biomedical literature and download supplementary materials from PMC open-access articles.",
    "Use for literature and supplementary discovery. Search, supplementary, PDF, and workspace bytes are preparation only; formal open-access full text uses one verified PMCID per binding through Core provider pubmed.files.v1.",
    ["search_pubmed", "download_supplementary", "extract_supplementary_archive"],
  ),
  mapping(
    "dbsnp",
    "discovery",
    ["dbsnp", "ncbi_variation"],
    "Look up verified RefSNP records by rsID through the official NCBI Variation API.",
    "Use to verify rsIDs, placements, and alleles. For formal Dynamic Family input, reacquire one verified rsID per binding through Core provider dbsnp.files.v1; failed records remain unavailable.",
    ["lookup_dbsnp"],
  ),
  mapping(
    "gwas_catalog",
    "discovery",
    ["gwas_catalog", "ebi_gwas"],
    "Find official GWAS Catalog studies by PubMed ID and association records by GCST accession or rsID.",
    "Resolve exact GCST studies, then query by GCST or rsID. Results are discovery only. gwas-catalog.associations.v1 is wired for Dynamic Family acquisition and does not require a static GWAS family; use one verified GCST or rsID per binding.",
    ["lookup_gwas_catalog"],
  ),
  mapping(
    "openfda",
    "discovery",
    ["openfda", "faers"],
    "Look up exact MedDRA reaction counts from official openFDA FAERS aggregates.",
    "Use for retrieval-time FAERS reaction counts. Counts are not deduplicated patients or causal evidence; formal Dynamic Family input reacquires one verified generic drug name per binding through openfda.files.v1.",
    ["lookup_openfda_dili_counts"],
  ),
  mapping(
    "clinvar",
    "discovery",
    ["clinvar", "ncbi"],
    "Look up total and pathogenic ClinVar variant counts for verified gene symbols.",
    "Use for gene-level count summaries after symbol verification. Counts do not replace variant records; formal record input uses a verified ClinVar accession or UID through clinvar.files.v1.",
    ["lookup_clinvar_counts"],
  ),
  mapping(
    "mgnify",
    "discovery",
    ["mgnify", "metagenomics"],
    "Search official MGnify study metadata through its JSON API without browser rendering.",
    "Use to discover study metadata and accessions. Metadata contains no abundance or association estimates; formal Dynamic Family metadata input reacquires one study through mgnify.files.v1.",
    ["search_mgnify_studies"],
  ),
  mapping(
    "chembl",
    "discovery",
    ["chembl"],
    "Search ChEMBL for controlled target and molecule identifiers used by formal bioactivity acquisition.",
    "Use search results only to discover controlled ChEMBL IDs. Formal bioactivity bytes must be reacquired by Dataset Core through chembl.files.v1; never use search or workspace responses as carriers.",
    ["search_chembl"],
  ),
  mapping(
    "uniprot",
    "discovery",
    ["uniprot"],
    "Search UniProt for verified protein accessions and terminology used by formal acquisition.",
    "Use to ground protein accessions and terminology during research. Formal Dynamic Family input reacquires one verified accession per binding through uniprot.files.v1.",
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
    "Use for structure discovery and traceable downloads. Formal Dynamic Family input reacquires one verified PDB ID per binding through pdb.files.v1.",
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
    "Search Reactome and fetch pathway participants through its official structured API.",
    "Use for pathway discovery, participants, and stable IDs. Formal Dynamic Family input reacquires one verified stable pathway ID per binding through reactome.files.v1.",
    ["search_reactome", "get_pathway", "download_reactome"],
  ),
  mapping(
    "browser",
    "acquisition",
    ["browser", "http", "web"],
    "Render and navigate public web pages and download files through verified content-addressed staging with guarded browser automation.",
    "Use for public-page research or known downloads.",
    ["navigate_page", "download_from_page"],
  ),
  mapping(
    "web_search_discovery",
    "discovery",
    ["web_search", "browser", "web"],
    "Find sources, official entries, and download locations on the open web via a search-engine result page (e.g. Bing) through the guarded browser.",
    "Use early during source discovery whenever a needed source or entry is not already in hand: read result-page links, prefer official hosts, then acquire real bytes through the browser skill or a registered Core provider.",
    ["navigate_page"],
    { guidanceOnly: true },
  ),
  mapping(
    "github-api",
    "discovery",
    ["github", "web"],
    "Route GitHub-hosted files and docs to reachable REST/raw entry points and avoid unreachable mirrors. Invoke when a needed data file or doc lives on GitHub or official sources are unreachable.",
    "Use only after official sources are exhausted: search api.github.com, list a repo contents to confirm path and ref, then fetch via github.com/{owner}/{repo}/raw/{ref}/{path}; never guess CDN/raw mirrors. GitHub downloads are staging evidence, never formal carriers.",
    ["download_from_page", "navigate_page"],
    { guidanceOnly: true },
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
    ["extract_chart_data_vlm", "extract_registered_paper_chart_evidence", "vlm", "chart_extraction"],
    "Extract structured chart data from paper figures or PDFs with the visual model; registered paper evidence is the only promotion path.",
    "Use only for genuine charts or figures. extract_chart_data_vlm is exploratory staging and cannot publish. Formal promotion runs only through extract_registered_paper_chart_evidence on registered paper assets; points stay pending evidence-bound review.",
    ["extract_chart_data_vlm", "extract_registered_paper_chart_evidence"],
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
    "Construct a DatasetExecution through the trusted Dataset Core boundary.",
    "Inspect routes first. Use validate/execute only for an exact static match. Otherwise request the Core profile scaffold, then prepare/submit with dynamic-bindable or Core-derived inputs. Acquisition-only carriers require formal extraction. Only Publication is formal.",
    // Pi-side tool names. The legacy Python Agent registers the equivalent
    // pipeline tools as validate_dataset_execution_spec / execute_dataset_execution
    // (backend/app/pipeline/dataset_execution_tool.py); Phase 5/8 converges on
      // these Pi names.
      [
        "inspect_dataset_execution_routes",
        "scaffold_dataset_profile",
        "scaffold_dataset_execution_spec",
        "preflight_cleaning_rules",
        "inspect_source_coverage",
        "validate_dataset_execution",
      "execute_dataset_execution",
      "prepare_dynamic_family_publication",
      "submit_dynamic_family_publication",
    ],
  ),
]);

export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(
  SKILL_TOOL_MAP.flatMap((entry) => entry.tools),
);

export function toolOwner(toolName: string): string | undefined {
  for (const entry of SKILL_TOOL_MAP) {
    if (entry.guidance_only === true) continue;
    if (entry.tools.includes(toolName)) return entry.name;
  }
  return undefined;
}
