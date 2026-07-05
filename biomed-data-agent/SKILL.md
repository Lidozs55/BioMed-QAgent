---
name: biomed-data-agent
description: Biomedical multi-source data discovery, parsing, cleaning, analysis and provenance-tracked export. Invoke when user asks to find/integrate/clean/analyze/visualize biomedical data (genes, compounds, targets, pathways, expression, PPI, structures) or export with citations.
---

# BioMed Data Agent

A biomedical research data integration skill. Given a natural-language research goal (e.g. "analyze the effect of Jianpi Sanjie formula on pancreatic cancer liver metastasis"), this skill executes the full pipeline: **data discovery → acquisition → parsing → cleaning/field alignment → analysis → review → structured export with provenance**.

The skill targets the competition problem "Scientific Data Discovery, Parsing and Integration" (方向1-A). It covers all seven core capabilities required by the problem statement: data discovery, data parsing, data cleaning, field alignment, source annotation, structured output, and chart-data processing — plus all three bonus items (auto-detect missing/duplicate/unit-inconsistency, auto-detect chart axis/legend errors, human-in-the-loop correction).

## When To Use

**Use this skill when:**

- The user describes a biomedical research goal and wants relevant data found, integrated, and exported.
- The user asks for data from biomedical sources (PubMed, GEO, STRING, KEGG, PDB, NCBI, TCMSP).
- The user needs field alignment across heterogeneous biomedical sources (gene symbols, compound names, units).
- The user needs bioinformatics analysis (differential expression, GO/KEGG enrichment, PPI network).
- The user needs CSV/Excel export with source citations, confidence scores, and lineage.
- The user asks to extract structured data from biomedical chart images.

**Do NOT use this skill when:**

- The task is purely software engineering with no biomedical data component.
- The user only wants a literature search without data extraction (use WebSearch directly).

## Tool Usage Priority

When you need to perform any capability, choose tools in the following four-tier order. **The built-in scripts in this skill are a supplement, not the first choice — and writing your own script is the absolute last resort.**

### Priority 1 — Use scheduler built-in capabilities first

Always prefer what the scheduler already provides natively. Do NOT call this skill's scripts for tasks the scheduler can already do:

| Capability | What to use |
|---|---|
| File read / write / edit | Scheduler's native file tools |
| Code search (glob / grep / semantic) | Scheduler's native search tools |
| Terminal / shell / Bash execution | Scheduler's native shell tool (used to run this skill's Python scripts) |
| Web search | Scheduler's WebSearch |
| Web page fetch & reading | Scheduler's WebFetch |
| Browser automation (click / fill / screenshot) | Scheduler's browser tool or browser skill |
| Local image / screenshot understanding | Scheduler's native multimodal capability |
| PDF / Word / Excel / PPT handling | Scheduler's built-in document skills if available |
| Generic chart visualization | Scheduler's chart skill if available |
| MCP protocol | Scheduler's native MCP config |

### Priority 2 — Discover and use other available skills

Before reaching for this skill's built-in scripts, **actively search for and install other skills** that may better cover the task. The agent is encouraged to look for additional skills (from the scheduler's skill marketplace, community sources, or MCP servers) to supplement or replace the built-in scripts documented here.

Examples:
- For general data analysis on CSV/Excel → prefer a dedicated `data-analysis` skill.
- For general chart rendering → prefer a dedicated `chart-visualization` skill.
- For general PDF reading → prefer a dedicated `pdf` skill.
- For general Excel/Word editing → prefer dedicated `xlsx`/`docx` skills.

### Priority 3 — Use this skill's built-in scripts / sub-skills

Only when (1) the scheduler does not provide the capability natively AND (2) no other skill is available, use the built-in scripts listed in the [Built-in Tool Catalog](#built-in-tool-catalog) below. These scripts focus on **biomedical-specific** tasks and on **non-built-in capabilities** that schedulers commonly lack (see the "Fills a gap" column in the catalog).

> **Note for the agent:** When you find a better external skill for a task, use it and skip the corresponding built-in script. The built-in scripts exist only to guarantee a minimum viable toolset for biomedical data integration when nothing else is available.

### Priority 4 — Write your own script (last resort, with full QA)

If none of the above three layers can satisfy the task, write a custom script yourself. **Before putting the script into production use, you MUST complete a full debugging, verification, and review cycle:**

1. **Write** the script following the same conventions as this skill's built-in scripts (CLI-driven, `--help` self-documenting, structured JSON to stdout, progress to stderr, exit code 0 = success).
2. **Debug** — run it on a small sample input and fix any runtime errors.
3. **Verify** — run it on representative inputs and check the output conforms to the relevant schema in `schemas/`.
4. **Review** — inspect the output for correctness (plausible values, no fabricated data, source citations intact) before using it in the real pipeline.
5. Only after all four steps pass, use the script's output in the pipeline. Otherwise fall back to manual extraction or ask the user.

> Custom scripts must respect the same Key Constraints as built-in ones: provenance is non-negotiable, no fabricated data, respect rate limits, keep outputs reproducible.

## Pipeline Overview

The skill executes a 6-stage pipeline. Each stage produces structured `DataRecord` objects (see `schemas/data_record.schema.json`) and records provenance nodes (see `schemas/provenance_node.schema.json`).

```
Stage 1: SEARCH      — Query biomedical APIs (PubMed/NCBI/GEO/STRING/KEGG/PDB/TCMSP)
Stage 2: ACQUIRE     — For sources without APIs, fall back to scheduler web tools
Stage 3: PARSE       — Parse PDF tables, GEO SOFT, PDB, FASTA, network files
Stage 4: CLEAN       — Field alignment, unit normalization, deduplication, conflict detection
Stage 5: ANALYZE     — (Optional) Differential expression, GO/KEGG enrichment, PPI analysis
Stage 6: EXPORT      — CSV/Excel with source columns + JSON lineage graph
```

## Execution Workflow

When this skill is invoked, follow these steps in order. Maintain a checklist and mark each step as done before proceeding.

### Step 1 — Understand the Research Goal

- Identify key entities (compounds, genes, diseases, pathways) from the user's query.
- Identify the research domain (TCM, oncology, molecular biology, etc.).
- Load the matching domain template from `domain_templates/` if one exists.
- Decide which data sources are relevant (see `references/datasource_catalog.md`).
- If the goal is ambiguous, ask the user at most ONE clarifying question, then proceed with best assumptions.

### Step 2 — Search (Stage 1)

Use `scripts/datasources/` clients to query each relevant source in parallel when possible.

- PubMed / NCBI: `pubmed_client.py`, `ncbi_client.py`
- Gene expression: `geo_client.py`
- Protein interactions: `string_client.py`
- Pathways: `kegg_client.py`
- Protein structures: `pdb_client.py`
- TCM compounds: `tcmsp_client.py`

Each client returns a list of `SearchResult` objects. Mark any source without a usable API as `requires_crawl: true` and defer to Stage 2.

**Failure policy:** If a source returns an error or empty results, log it and continue with other sources. Do NOT abort the whole pipeline.

### Step 3 — Acquire (Stage 2)

For sources marked `requires_crawl: true`:

1. Prefer the scheduler's built-in WebFetch for static HTML pages.
2. Use the scheduler's browser automation for dynamic JavaScript-rendered pages.
3. Only fall back to writing a custom Playwright script if neither works.

### Step 4 — Parse (Stage 3)

Use `scripts/parsers/` to convert raw data into `DataRecord` objects:

- `pdf_table_parser.py` — Extract tables from biomedical literature PDFs (fills a gap when the scheduler has no PDF skill).
- `geo_soft_parser.py` — Parse GEO SOFT format into expression matrices.
- `pdb_parser.py` — Parse PDB structure files.
- `fasta_parser.py` — Parse FASTA sequences.
- `network_parser.py` — Parse STRING TSV / Cytoscape SIF / GraphML.
- For unstructured text, the scheduler LLM itself performs extraction (do not duplicate).

If the scheduler has a capable PDF skill, prefer it for general PDF reading; use `pdf_table_parser.py` only when extracting structured experimental data tables from biomedical literature.

Each parser must populate `extraction_method`, `extraction_confidence`, and `source_ref` on every record.

### Step 5 — Clean & Align (Stage 4)

This is the most important stage for the competition scoring. Use `scripts/cleaners/`:

- `field_aligner.py` — Map source-specific field names to unified names using `dictionaries/`.
- `unit_normalizer.py` — Normalize units (e.g. `logFC` ↔ `log2FoldChange` → `log2fc`, `ln` → `log2`, `μM` → `uM`).
- `duplicate_dedector.py` — Detect duplicates, keep the highest-confidence version; flag conflicts where values diverge by more than 20%.

After cleaning, output:

- A cleaned `DataRecord` list.
- A `FieldMapping` table (see `schemas/field_mapping.schema.yaml`).
- A conflict report listing any entity with inconsistent values across sources.

**Human-in-the-loop:** If a conflict cannot be auto-resolved and the values diverge by more than 20%, mark the record with `quality_flags: ["needs_review"]` and surface it to the user at the end. This satisfies the competition bonus item "complete correction or seek human suggestion then correct".

### Step 6 — Analyze (Stage 5, optional)

Only run if the user explicitly asks for analysis, or if the cleaned data clearly supports it (e.g. an expression matrix).

Use `scripts/analysis/`:

- `differential_expression.py` — DESeq2-style stats on expression matrix (BH FDR correction, with pure-Python fallback when statsmodels is missing).
- `enrichment.py` — GO/KEGG enrichment via Enrichr API (degrades to gene-list output when Enrichr is unavailable).
- `ppi_network.py` — Build PPI network from STRING, compute centrality (degrades to edge-list when networkx is missing).

Each analysis produces an `AnalysisResult` with stats tables.

### Step 7 — Visualize (optional)

These biomedical-specific charts are rarely provided by schedulers' generic chart skills. Use `scripts/viz/` only when the user asks for them or when analysis results warrant visualization:

- `volcano_plot.py` — For differential expression results.
- `enrichment_bubble.py` — For GO/KEGG enrichment.
- `heatmap.py` — For expression matrices.
- `network_plot.py` — For PPI networks.
- `extract_chart_data.py` — Extract structured data from a local chart **image** (e.g. a published volcano plot) via the Qwen-VL API. Fills a gap when the scheduler cannot read local images; requires `QWEN_API_KEY` env var. Skip if the scheduler already understands local images natively.

All charts are saved as PNG to the task output directory and embedded in the final report.

**Chart-data validation (competition bonus item):** Whenever data is extracted from a chart image (via `extract_chart_data.py` or the scheduler's native image understanding), validate the result before accepting it:

- Check axis ranges are plausible (e.g. `log2FC` typically within ±10, p-value between 0 and 1).
- Check the legend matches the extracted series (gene/compound names should align with the query context).
- Check data point count is consistent with the visible plot density.

If an axis label or legend entry is ambiguous, conflicting, or looks mis-parsed, mark the affected records with `quality_flags: ["chart_axis_unclear"]` or `["legend_unclear"]` and surface them to the user in the final summary. This satisfies the competition bonus item "auto-detect chart axis or legend parsing errors".

### Step 8 — Export (Stage 6)

Produce final deliverables in the task output directory (default: `data/output/<task_id>/`):

- `data.csv` — Unified table, one row per record, with mandatory columns: `record_id`, all unified fields, `source_doi`, `source_url`, `extraction_method`, `extraction_confidence`, `quality_flags`.
- `field_mapping.json` — The field alignment table.
- `lineage.json` — Full provenance graph (see `schemas/provenance_node.schema.json`).
- `report.md` — Human-readable summary: total records, average confidence, source counts, top conflicts, analysis highlights.
- `charts/` — All visualization PNGs.
- `data.xlsx` — Excel version with two sheets: "Data" (the records) and "Lineage" (the provenance nodes). Generated by `scripts/export/to_excel.py`. Fills a gap when the scheduler has no Excel skill.
- `report.docx` — Optional Word version of the report. Generated by `scripts/export/to_docx.py` (requires python-docx; degrades gracefully if missing). Prefer a scheduler docx skill if available.
- `report.pdf` — Optional PDF version of the report. Generated by `scripts/export/to_pdf.py` (requires reportlab; auto-detects Chinese fonts; degrades gracefully if missing). This satisfies the competition's "PPT/PDF submission" requirement.
- `report.pptx` — Optional PPT version of the report, capped at 20 slides per competition requirement. Generated by `scripts/export/to_pptx.py` (requires python-pptx; degrades gracefully if missing). This satisfies the competition's "PPT/PDF submission" requirement.

### Step 9 — Summarize to User

Reply to the user with:

1. Total records found, by source.
2. Average confidence score.
3. Number of conflicts requiring review (if any).
4. Path to the output directory.
5. A 3-bullet executive summary of findings.

Keep the reply under 15 lines unless the user asks for detail.

## Built-in Tool Catalog

All scripts are CLI-driven and self-documenting via `--help`. Run them through the scheduler's shell tool. Full reference: `references/datasource_catalog.md`, `references/field_mapping_rules.md`, `references/analysis_recipes.md`.

> **Priority reminder:** For every row below, first check whether the scheduler (or another installed skill) can already do the task. The "Fills a gap" column marks scripts that substitute for capabilities most schedulers lack — these are the ones you should fall back to when nothing else is available.

### Data Source Clients — `scripts/datasources/`

Biomedical API clients. All inherit `BaseDataSource` with a 1 req/sec rate limiter. These are biomedical-specific and not provided by any generic scheduler.

| Script | Purpose | Fills a gap |
|---|---|---|
| `pubmed_client.py` | Search PubMed via NCBI E-utilities (esearch + efetch) | Biomedical-specific |
| `ncbi_client.py` | Query NCBI Gene / Protein databases | Biomedical-specific |
| `geo_client.py` | Search GEO expression datasets | Biomedical-specific |
| `string_client.py` | Query STRING PPI network API | Biomedical-specific |
| `kegg_client.py` | Query KEGG REST API for pathways | Biomedical-specific |
| `pdb_client.py` | Search RCSB PDB protein structures | Biomedical-specific |
| `tcmsp_client.py` | Query TCMSP for TCM compounds (returns `requires_crawl` when blocked) | Biomedical-specific |

### Parsers — `scripts/parsers/`

Convert raw biomedical data into `DataRecord` JSON. All text reads use `utf-8-sig` to handle BOM.

| Script | Purpose | Fills a gap |
|---|---|---|
| `pdf_table_parser.py` | Extract tables from biomedical literature PDFs (pdfplumber) | Yes — most schedulers lack PDF parsing |
| `geo_soft_parser.py` | Parse GEO SOFT format into expression matrices (pure Python, handles gzip) | Biomedical-specific |
| `pdb_parser.py` | Parse PDB structure files (HEADER/SEQRES/ATOM/HETATM) | Biomedical-specific |
| `fasta_parser.py` | Parse FASTA sequences (streaming, auto protein/dna detection) | Biomedical-specific |
| `network_parser.py` | Parse STRING TSV / Cytoscape SIF / GraphML | Biomedical-specific |

### Cleaners — `scripts/cleaners/`

Data cleaning and field alignment. Core to the competition scoring.

| Script | Purpose | Fills a gap |
|---|---|---|
| `field_aligner.py` | Map source-specific field names to unified names using `dictionaries/` (dual-layer normalization: `_norm_key` + `_compact_key`) | Biomedical-specific |
| `unit_normalizer.py` | Normalize units (ln→log2, log10→log2, fold_change→log2fc, μM→uM) | Biomedical-specific |
| `duplicate_dedector.py` | Detect duplicates (entity key: gene_symbol+compound_name+context) and conflicts (>20% divergence) | Biomedical-specific |

### Analysis — `scripts/analysis/`

Bioinformatics analysis. Optional, runs only when the user asks or the data supports it.

| Script | Purpose | Fills a gap |
|---|---|---|
| `differential_expression.py` | Differential expression stats with BH FDR correction (pure-Python fallback) | Biomedical-specific |
| `enrichment.py` | GO/KEGG enrichment via Enrichr API (degrades to gene-list output) | Biomedical-specific |
| `ppi_network.py` | Build PPI network from STRING + compute centrality (networkx; edge-list fallback) | Biomedical-specific |

### Provenance — `scripts/provenance/`

Source tracing with DAG validation. Satisfies the competition requirement "data source traceability".

| Script | Purpose | Fills a gap |
|---|---|---|
| `tracker.py` | Record / link / export lineage (reverse BFS to root sources) | Biomedical-specific |
| `query.py` | Query lineage by record_id (text/json output) | Biomedical-specific |

### Visualization — `scripts/viz/`

Biomedical-specific charts. Most schedulers' generic chart skills do not cover these plot types.

| Script | Purpose | Fills a gap |
|---|---|---|
| `volcano_plot.py` | Volcano plot for differential expression | Yes — generic chart skills rarely cover this |
| `enrichment_bubble.py` | Bubble plot for GO/KEGG enrichment | Yes — generic chart skills rarely cover this |
| `heatmap.py` | Clustered heatmap for expression matrices (seaborn clustermap) | Yes — generic chart skills rarely cover this |
| `network_plot.py` | Network graph for PPI | Yes — generic chart skills rarely cover this |
| `extract_chart_data.py` | Extract structured data from a local chart **image** via Qwen-VL API (requires `QWEN_API_KEY`) | Yes — substitutes for missing local-image understanding |

### Export — `scripts/export/`

Final deliverables with mandatory source-citation columns.

| Script | Purpose | Fills a gap |
|---|---|---|
| `to_csv.py` | CSV export with source columns | Biomedical-specific (source columns) |
| `to_excel.py` | Excel export with two sheets (Data + Lineage), styled headers | Yes — most schedulers lack Excel generation |
| `to_report.py` | 8-section Chinese Markdown report | Biomedical-specific |
| `to_docx.py` | Word version of the report (python-docx; degrades if missing) | Yes — most schedulers lack Word generation |
| `to_pdf.py` | PDF version of the report (reportlab; auto-detects Chinese fonts; degrades if missing) | Yes — most schedulers lack PDF generation |
| `to_pptx.py` | PPT version of the report, capped at 20 slides per competition requirement (python-pptx; degrades if missing) | Yes — most schedulers lack PPT generation |

### File Format Conversion — `scripts/io/`

Convert between user-uploaded files and `DataRecord` JSON.

| Script | Purpose | Fills a gap |
|---|---|---|
| `csv_to_json.py` | CSV → DataRecord JSON | Biomedical-specific (schema-aligned) |
| `excel_to_json.py` | Excel → DataRecord JSON (openpyxl) | Yes — most schedulers lack Excel reading |
| `json_to_csv.py` | DataRecord JSON → CSV | Biomedical-specific |
| `json_to_excel.py` | DataRecord JSON → Excel | Yes — most schedulers lack Excel generation |
| `merge_json.py` | Merge multiple JSON files / directories with dedup | Biomedical-specific |

## Data Transfer Conventions

All inter-stage data MUST conform to the schemas in `schemas/`:

- `data_record.schema.json` — The unified record format. Every stage outputs lists of these. Mandatory fields: `record_id`, `task_id`, `fields`, `source_ref`, `extraction_method`, `extraction_confidence`.
- `source_reference.schema.json` — How a source is cited (URL, DOI, PMID, accession, query, timestamp).
- `field_mapping.schema.yaml` — How source fields map to unified fields.
- `provenance_node.schema.json` — One node in the lineage graph (DAG node).
- `lineage_graph.schema.yaml` — Full lineage graph structure.

Do NOT invent ad-hoc JSON shapes. If a stage's output does not validate against the schema, fix the stage before continuing.

## Script Invocation

All scripts are run via the scheduler's shell tool with `python` (Python 3.10+). Install dependencies first:

```bash
pip install -r scripts/requirements.txt
```

Each script is CLI-driven and self-documenting via `--help`. Examples:

```bash
# Search PubMed for a query
python scripts/datasources/pubmed_client.py --query "pancreatic cancer liver metastasis" --max 50 --out results/pubmed.json

# Parse a GEO SOFT file
python scripts/parsers/geo_soft_parser.py --input GSE12345.family.soft.gz --out results/geo_expr.json

# Align fields across sources
python scripts/cleaners/field_aligner.py --input results/raw/ --out results/cleaned.json --dictionaries dictionaries/

# Generate a volcano plot
python scripts/viz/volcano_plot.py --input results/diff_expr.json --out charts/volcano.png

# Convert user-uploaded Excel to DataRecord JSON
python scripts/io/excel_to_json.py --input uploads/data.xlsx --out results/uploaded.json

# Export final records to Excel with lineage sheet
python scripts/export/to_excel.py --input results/cleaned.json --lineage results/lineage.json --out output/data.xlsx
```

Every script emits structured JSON to stdout (or `--out` file) and human-readable progress to stderr. Exit code 0 = success, non-zero = failure with an error message on stderr.

## Failure Handling

- **Network errors:** Retry once with backoff. If still failing, log and continue.
- **Parse errors:** Skip the malformed record, log it, continue parsing the rest.
- **Schema validation errors:** These are bugs. Fix the producing script before proceeding.
- **Missing optional dependency:** Install via `pip install <pkg>` in the sandbox. If install fails, degrade gracefully and note it in the report.

## Domain Templates

When the research goal matches a known domain, load the corresponding template from `domain_templates/`:

- `tcm.yaml` — Traditional Chinese Medicine research (TCMSP priority, compound-target-pathway focus, OB≥30% / DL≥0.18 filters).
- `oncology.yaml` — Cancer research (GEO/TCGA priority, expression + mutation focus).

Templates specify: priority data sources, recommended field mappings, analysis recipes, and confidence thresholds.

## Key Constraints

- **Provenance is non-negotiable.** Every output record MUST trace back to its original source. No record without a `source_ref` is allowed in the final export. This directly satisfies the competition's "source traceability" evaluation criterion.
- **Do not fabricate data.** If a source does not return data, the record does not exist. Never invent values to "fill gaps."
- **Respect rate limits.** All API clients use a default 1 req/sec rate. Do not remove throttling.
- **Keep outputs reproducible.** Save the exact query strings and API responses in the lineage graph.
- **Prefer scheduler and external skills over built-in scripts.** Built-in scripts are a supplement, not a replacement for scheduler capabilities. Always check native tools and other available skills first.
- **Local image understanding fallback.** If the scheduler cannot read a local chart image, use `scripts/viz/extract_chart_data.py` (requires `QWEN_API_KEY`). Otherwise prefer the scheduler's native multimodal capability.

## File Index

```
biomed-data-agent/
├── SKILL.md                          # This file
├── scripts/                          # Executable Python scripts (last-resort supplement)
│   ├── requirements.txt
│   ├── datasources/                  # 7 biomedical API clients
│   ├── parsers/                      # 5 biomedical format parsers
│   ├── cleaners/                     # Cleaning & field alignment
│   ├── analysis/                     # Bioinformatics analysis
│   ├── provenance/                   # Lineage tracker & query
│   ├── viz/                          # Biomed visualizations + image data extraction
│   ├── export/                       # Final export (CSV/Excel/Markdown/Word)
│   └── io/                           # File format conversion (Excel/CSV/JSON)
├── schemas/                          # JSON/YAML schemas for data transfer
├── dictionaries/                     # Synonym dictionaries (genes, compounds, units, fields)
├── domain_templates/                 # Per-domain config (TCM, oncology)
├── examples/                         # Input/output examples
└── references/                       # Detailed reference docs
```

For detailed reference, see:

- `references/datasource_catalog.md` — Full list of data sources and their API specs.
- `references/field_mapping_rules.md` — Field alignment rules and examples.
- `references/analysis_recipes.md` — Analysis parameter recommendations.
