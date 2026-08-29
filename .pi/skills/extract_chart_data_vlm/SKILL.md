---
name: extract_chart_data_vlm
description: Extract structured chart data from paper figures or PDFs using the Qwen-VL visual model.
---

# Chart data extraction (VLM)

Use `extract_chart_data_vlm` when you need structured data (chart_type, axes,
data_points, legend) from a paper chart, plot, or figure already acquired as a
PNG/JPG image or PDF.

## Accepted inputs

- For formal evidence, pass a task-owned Core source_asset_id returned by
  Core acquisition or `extract_supplementary_archive`.
- source_path accepts preparation-only screenshots/PDFs and never creates a
  formal carrier.

## Behavior

- Three-tier degradation: L1 Qwen-VL → L2 pdfplumber tables → L3 caption text.
- Raises on full failure — no silent empty-data fallback.
- Writes chart_data.csv, chart_data_points.csv and a content-addressed evidence
  manifest under parsed/chart_data/.
- With source_asset_id, Dataset Core registers the evidence manifest and a
  matching OperationResult. The manifest binds model/version, prompt digest,
  page/bbox, confidence and point-level HIL facts.

## When not to use

- Not for pure text extraction: use `extract_pdf_tables` for tables and
  `extract_pdf_metadata` for titles/authors/abstracts.
- Do not call repeatedly on the same image.

## Constraints

- Path-based extracted data is preparation material, not a formal artifact.
  Only the Core-registered evidence manifest returned for source_asset_id may
  enter a profile-scaffolded formal build.
- A literature-derived quantitative product uses the tables paper_records,
  experiment_records, primary activity_value_records, chart_series,
  chart_points, and supplementary_asset_records; do not collapse it into a
  generic evidence/papers pair.
- Chart series carry human_review_status, and chart points carry review_status.
  Estimated or uncertain values remain human_review_pending until genuine
  evidence-bound HIL acceptance.
- Approval to use VLM credentials is not chart-data review and must never be
  treated as publication acceptance.
