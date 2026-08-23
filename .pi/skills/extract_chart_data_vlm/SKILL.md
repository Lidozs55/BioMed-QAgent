---
name: extract_chart_data_vlm
description: Extract structured chart data from paper figures or PDFs using the Qwen-VL visual model.
---

# Chart data extraction (VLM)

Use `extract_chart_data_vlm` when you need structured data (chart_type, axes,
data_points, legend) from a paper chart, plot, or figure already acquired as a
PNG/JPG image or PDF.

## Accepted inputs

- Outputs of `capture_web_page` and `capture_page_section` (screenshots).
- PDFs from `download_supplementary`.
- Standalone JPG/WEBP figure images.

## Behavior

- Three-tier degradation: L1 Qwen-VL → L2 pdfplumber tables → L3 caption text.
- Raises on full failure — no silent empty-data fallback.
- Writes chart_data.csv and chart_data_points.csv under parsed/chart_data/.

## When not to use

- Not for pure text extraction: use `extract_pdf_tables` for tables and
  `extract_pdf_metadata` for titles/authors/abstracts.
- Do not call repeatedly on the same image.

## Constraints

- Extracted data is preparation material, not a formal artifact: it may inform
  research but never replaces the trusted Dataset Core publication path.
- A literature-derived quantitative product uses the tables paper_records,
  experiment_records, primary activity_value_records, chart_series,
  chart_points, and supplementary_asset_records; do not collapse it into a
  generic evidence/papers pair.
- Chart series carry human_review_status, and chart points carry review_status.
  Estimated or uncertain values remain human_review_pending until genuine
  evidence-bound HIL acceptance.
- Approval to use VLM credentials is not chart-data review and must never be
  treated as publication acceptance.
