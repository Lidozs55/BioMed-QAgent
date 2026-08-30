---
name: extract_chart_data_vlm
description: Extract chart data from paper figures with the visual model; registered paper evidence is the only formal promotion path.
---

# Chart data extraction (VLM)

Two tools belong to this skill:

- `extract_registered_paper_chart_evidence` — the governed paper chart
  promotion path. It consumes only task-owned registered assets (paper
  full-text XML asset, paper PDF asset, optional registered supplementary
  assets), records resolved model provenance and page/figure/bbox locators,
  and registers ONE content-addressed evidence carrier for later
  evidence-bound review.
- `extract_chart_data_vlm` — exploratory extraction into workspace CSV
  staging. It CANNOT publish and its outputs are never formal artifacts.

## Accepted inputs

Governed promotion (`extract_registered_paper_chart_evidence`):

- Pass a task-owned Core source_asset_id returned by Core acquisition,
  `extract_supplementary_archive`, or another governed registration step.
- Registered asset ids only (asset_<sha256>): never absolute paths,
  workspace-relative paths, or browser screenshots.
- One paper full-text XML asset (application/xml or text/xml) and one paper
  PDF asset (application/pdf), plus optional registered supplementary assets.

Exploratory staging (`extract_chart_data_vlm`):

- A source path accepts preparation-only screenshots/PDFs and never creates a
  formal carrier.
- Outputs of `capture_web_page` and `capture_page_section` (screenshots).
- PDFs from `download_supplementary`; standalone JPG/WEBP figure images.

## Behavior

Governed promotion:

- Every input resolves and byte-verifies through the task SourceAssetRegistry
  before any model call; wrong media types, unregistered digests, and
  cross-task asset ids are rejected up front.
- VLM candidates become paper_records, experiment_records,
  activity_value_records, supplementary_asset_records, chart_series,
  chart_points, papers, and sources rows in one registered JSON carrier.
- With source_asset_id, Dataset Core registers the evidence manifest and a
  matching OperationResult. The manifest binds model/version, prompt digest,
  page/figure/bbox, confidence and point-level HIL facts.
- Every VLM-derived chart point is estimated and pending; unclear axis or
  legend semantics yield an explicit unclear no-points series, never exact
  points.
- The frozen execution context (system prompt) is binding task semantics for
  which papers and tables are required, but it is never publication authority:
  it does not replace registered carriers, review gates, or the Dataset Core
  publication path.
- If a required carrier (full-text XML, PDF, supplement), the visual model, a
  usable page locator, or the evidence-bound review is unavailable, return the
  structured blocker for that paper instead of falling back to a workspace
  CSV.

Exploratory staging:

- Three-tier degradation: L1 Qwen-VL/visual model → L2 pdfplumber tables → L3
  caption text. Raises on full failure — no silent empty-data fallback.
- Writes chart_data.csv and chart_data_points.csv under parsed/chart_data/.
- Concurrent tool calls are queued and executed one at a time. Each invocation
  keeps its own credential and data-review HIL; a pending review must never
  cause sibling figure extractions to fail or bypass review.

## When not to use

- Not for pure text extraction: use `extract_pdf_tables` for tables and
  `extract_pdf_metadata` for titles/authors/abstracts.
- Do not call repeatedly on the same image.

## Constraints

- Extracted data is preparation material, not a formal artifact: it may inform
  research but never replaces the trusted Dataset Core publication path.
- Path-based extracted data is preparation material, not a formal artifact.
  Only the Core-registered evidence manifest returned for source_asset_id may
  enter a profile-scaffolded formal build.
- Only `extract_registered_paper_chart_evidence` promotes paper chart evidence
  toward a formal product; `extract_chart_data_vlm` cannot publish.
- A literature-derived quantitative product uses the tables paper_records,
  experiment_records, primary activity_value_records, chart_series,
  chart_points, and supplementary_asset_records; do not collapse it into a
  generic evidence/papers pair.
- Chart series carry human_review_status, and chart points carry review_status.
  Estimated or uncertain values remain human_review_pending until genuine
  evidence-bound HIL acceptance.
- Approval to use VLM credentials is not chart-data review and must never be
  treated as publication acceptance.
