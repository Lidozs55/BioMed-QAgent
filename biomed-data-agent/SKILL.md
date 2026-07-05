---
name: biomed-data-agent
description: Biomedical multi-source data discovery, parsing, cleaning, analysis and provenance-tracked export. Invoke when user asks to find/integrate/clean/analyze/visualize biomedical data (genes, compounds, targets, pathways, expression, PPI, structures) or export with citations. Works on both Trae Work and Qoder/Qoder Work.
---

# BioMed Data Agent

A biomedical research data integration skill. Given a natural-language research goal (e.g. "analyze the effect of Jianpi Sanjie formula on pancreatic cancer liver metastasis"), this skill executes the full pipeline: **data discovery → acquisition → parsing → cleaning/field alignment → analysis → review → structured export with provenance**.

## When To Use

**Use this skill when:**

- The user describes a biomedical research goal and wants relevant data found, integrated, and exported.
- The user asks for data from biomedical sources (PubMed, GEO, STRING, KEGG, PDB, NCBI, TCMSP, TCM).
- The user needs field alignment across heterogeneous biomedical sources (gene symbols, compound names, units).
- The user needs bioinformatics analysis (differential expression, GO/KEGG enrichment, PPI network).
- The user needs CSV/Excel export with source citations, confidence scores, and lineage.
- The user asks for biomedical visualizations (volcano plot, enrichment bubble, heatmap, PPI network).

**Do NOT use this skill when:**

- The user only wants generic data analysis on CSV/Excel (use the built-in `data-analysis` skill).
- The user only wants generic chart visualization (use the built-in `chart-visualization` skill).
- The user only wants web browsing or scraping of non-biomedical sites (use `agent-browser`).
- The user only wants a literature search without data extraction (use WebSearch directly).
- The task is purely software engineering with no biomedical data component.

## Scheduler Compatibility

This skill is designed to run on both **Trae Work** and **Qoder / Qoder Work** schedulers. It deliberately avoids duplicating built-in capabilities of either platform.

### What this skill does NOT reimplement (use scheduler built-ins)

| Capability | Trae Work | Qoder / Qoder Work | How to use |
|------------|-----------|--------------------|-----------|
| File read/write | ✅ built-in | ✅ built-in | Scheduler's native file tools |
| WebFetch / web page reading | ✅ built-in | ✅ built-in (also via MCP fetch) | Scheduler's WebFetch tool |
| WebSearch | ✅ built-in | ✅ built-in | Scheduler's WebSearch tool |
| Bash / terminal execution | ✅ sandbox | ✅ Quest sandbox / Qoder Work safe env | Scheduler's shell tool |
| Browser automation | ✅ agent-browser skill | ✅ built-in Browser Use / Chrome MCP | Scheduler's browser tool |
| Generic chart visualization | ✅ chart-visualization skill | ✅ Canvas | Built-in chart skill |
| Generic PDF reading | ❌ | ✅ pdf skill (Qoder Work) | Built-in pdf skill |
| Generic Excel/Word/PPT | ❌ | ✅ xlsx/docx/pptx skills (Qoder Work) | Built-in office skills |
| MCP protocol | ✅ | ✅ | Scheduler's MCP config |

### What this skill provides (NOT in either scheduler)

- 7 biomedical data source API clients (PubMed/NCBI/GEO/STRING/KEGG/PDB/TCMSP)
- Biomedical format parsers (GEO SOFT, PDB, FASTA, biological network files)
- Field alignment engine for heterogeneous biomedical sources
- Bioinformatics analysis (differential expression, GO/KEGG enrichment, PPI network)
- Provenance / lineage tracking with DAG validation
- Biomedical-specific visualizations (volcano, enrichment bubble, heatmap, PPI network)
- Local image understanding via Qwen-VL API (covers Trae Work which lacks this; Qoder Work has built-in)
- Biomedical report generation (Markdown with embedded charts and lineage)
- Excel/CSV export with mandatory source citation columns

### Platform-specific notes

- **Trae Work**: Use the sandbox to run Python scripts. For local image understanding, this skill's `scripts/viz/extract_chart_data.py` is the only option (Trae Work cannot read local images natively).
- **Qoder Work**: Has built-in local image understanding and PDF/Excel/Word/PPT skills. This skill's pdf_table_parser.py focuses on **biomedical literature table extraction** (extracting experimental data tables with gene/compound/structure context), which is more specialized than the generic pdf skill. Prefer the built-in pdf skill for general PDF reading; use this skill's parser only when extracting structured biomedical data tables.
- **Qoder Quest**: Long-running pipeline runs well in Quest mode. The `record`/`link`/`export` provenance commands map naturally to Quest's task lifecycle.

## Pipeline Overview

The skill executes a 6-stage pipeline. Each stage produces structured `DataRecord` objects (see `schemas/data_record.schema.json`) and records provenance nodes (see `schemas/provenance_node.schema.json`).

```
Stage 1: SEARCH      — Query biomedical APIs (PubMed/NCBI/GEO/STRING/KEGG/PDB/TCMSP)
Stage 2: ACQUIRE     — For sources without APIs, fall back to scheduler WebFetch / agent-browser
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

- Prefer the scheduler's built-in WebFetch (Trae Work) or fetch MCP / built-in web tools (Qoder) for static HTML pages.
- Use the scheduler's browser automation (agent-browser skill on Trae; Browser Use on Qoder) for dynamic JavaScript-rendered pages.
- Only fall back to writing a custom Playwright script if neither works.

### Step 4 — Parse (Stage 3)

Use `scripts/parsers/` to convert raw data into `DataRecord` objects:

- `pdf_table_parser.py` — Extract tables from PDFs (uses pdfplumber).
- `geo_soft_parser.py` — Parse GEO SOFT format into expression matrices.
- `pdb_parser.py` — Parse PDB structure files.
- `fasta_parser.py` — Parse FASTA sequences.
- For unstructured text, the scheduler LLM itself performs extraction (do not duplicate).

Each parser must populate `extraction_method`, `extraction_confidence`, and `source_ref` on every record.

### Step 5 — Clean & Align (Stage 4)

This is the most important stage for the competition scoring. Use `scripts/cleaners/`:

- `field_aligner.py` — Map source-specific field names to unified names using `dictionaries/`.
- `unit_normalizer.py` — Normalize units (e.g. `logFC` ↔ `log2FoldChange` → `log2fc`).
- `duplicate_dedector.py` — Detect duplicates, keep the highest-confidence version.

After cleaning, output:
- A cleaned `DataRecord` list.
- A `FieldMapping` table (see `schemas/field_mapping.schema.yaml`).
- A conflict report listing any entity with inconsistent values across sources.

**Human-in-the-loop:** If a conflict cannot be auto-resolved and the values diverge by more than 20%, mark the record with `quality_flags: ["needs_review"]` and surface it to the user at the end.

### Step 6 — Analyze (Stage 5, optional)

Only run if the user explicitly asks for analysis, or if the cleaned data clearly supports it (e.g. an expression matrix).

Use `scripts/analysis/`:

- `differential_expression.py` — DESeq2-style stats on expression matrix.
- `enrichment.py` — GO/KEGG enrichment via Enrichr API.
- `ppi_network.py` — Build PPI network from STRING, compute centrality.

Each analysis produces an `AnalysisResult` with stats tables + visualization images.

### Step 7 — Visualize

Use `scripts/viz/` to produce biomed-specific charts (the built-in `chart-visualization` skill does NOT cover these):

- `volcano_plot.py` — For differential expression results.
- `enrichment_bubble.py` — For GO/KEGG enrichment.
- `heatmap.py` — For expression matrices.
- `network_plot.py` — For PPI networks.

All charts are saved as PNG to the task output directory and embedded in the final report.

### Step 8 — Export (Stage 6)

Produce final deliverables in the task output directory (default: `data/output/<task_id>/`):

- `data.csv` — Unified table, one row per record, with mandatory columns: `record_id`, all unified fields, `source_doi`, `source_url`, `extraction_method`, `extraction_confidence`, `quality_flags`.
- `field_mapping.json` — The field alignment table.
- `lineage.json` — Full provenance graph (see `schemas/provenance_node.schema.json`).
- `report.md` — Human-readable summary: total records, average confidence, source counts, top conflicts, analysis highlights.
- `charts/` — All visualization PNGs.
- `data.xlsx` — Excel version with two sheets: "Data" (the records) and "Lineage" (the provenance nodes). Generated by `scripts/export/to_excel.py`.
- `report.docx` — Optional Word version of the report (requires Qoder Work's docx skill OR python-docx). Generated by `scripts/export/to_report.py`.

### Step 9 — Summarize to User

Reply to the user with:
1. Total records found, by source.
2. Average confidence score.
3. Number of conflicts requiring review (if any).
4. Path to the output directory.
5. A 3-bullet executive summary of findings.

Keep the reply under 15 lines unless the user asks for detail.

## Data Transfer Conventions

All inter-stage data MUST conform to the schemas in `schemas/`:

- `data_record.schema.json` — The unified record format. Every stage outputs lists of these.
- `source_reference.schema.json` — How a source is cited (URL, DOI, query, timestamp).
- `field_mapping.schema.yaml` — How source fields map to unified fields.
- `provenance_node.schema.json` — One node in the lineage graph.

Do NOT invent ad-hoc JSON shapes. If a stage's output does not validate against the schema, fix the stage before continuing.

## Script Invocation

All scripts are run via the sandbox with `python` (Python 3.10+). Install dependencies first:

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
```

Every script emits structured JSON to stdout (or `--out` file) and human-readable progress to stderr. Exit code 0 = success, non-zero = failure with an error message on stderr.

## Failure Handling

- **Network errors:** Retry once with backoff. If still failing, log and continue.
- **Parse errors:** Skip the malformed record, log it, continue parsing the rest.
- **Schema validation errors:** These are bugs. Fix the producing script before proceeding.
- **Missing optional dependency:** Install via `pip install <pkg>` in the sandbox. If install fails, degrade gracefully and note it in the report.

## Domain Templates

When the research goal matches a known domain, load the corresponding template from `domain_templates/`:

- `tcm.yaml` — Traditional Chinese Medicine research (TCMSP priority, compound-target-pathway focus).
- `oncology.yaml` — Cancer research (GEO/TCGA priority, expression + mutation focus).

Templates specify: priority data sources, recommended field mappings, analysis recipes, and confidence thresholds.

## Key Constraints

- **Provenance is non-negotiable.** Every output record MUST trace back to its original source. No record without a `source_ref` is allowed in the final export.
- **Do not fabricate data.** If a source does not return data, the record does not exist. Never invent values to "fill gaps."
- **Respect rate limits.** All API clients use a default 1 req/sec rate. Do not remove throttling.
- **Keep outputs reproducible.** Save the exact query strings and API responses in the lineage graph.
- **No local image understanding built-in.** If the user needs to extract data from a local chart image, use `scripts/viz/extract_chart_data.py` which calls the Qwen-VL API (requires `QWEN_API_KEY` env var). Do not assume the scheduler can read local images directly.
- **Respect scheduler built-ins.** Do not reimplement generic PDF reading, Excel editing, web browsing, or chart rendering that the scheduler already provides. This skill's tools are scoped to biomedical-specific tasks only.

## File Index

```
biomed-data-agent/
├── SKILL.md                          # This file
├── scripts/                          # Executable Python scripts
│   ├── requirements.txt
│   ├── datasources/                  # API clients (7 sources)
│   ├── parsers/                      # Format parsers (5 parsers)
│   ├── cleaners/                     # Cleaning & field alignment
│   ├── analysis/                     # Bioinformatics analysis
│   ├── provenance/                   # Lineage tracker
│   ├── viz/                          # Biomed visualizations
│   ├── export/                       # Final export (CSV/Excel/Markdown/Word report)
│   └── io/                           # File format conversion (Excel/CSV/JSON)
├── schemas/                          # JSON/YAML schemas for data transfer
├── dictionaries/                     # Synonym dictionaries
├── domain_templates/                 # Per-domain config (TCM, oncology)
├── examples/                         # Input/output examples
└── references/                       # Detailed reference docs
```

For detailed reference, see:
- `references/datasource_catalog.md` — Full list of data sources and their API specs.
- `references/field_mapping_rules.md` — Field alignment rules and examples.
- `references/analysis_recipes.md` — Analysis parameter recommendations.
