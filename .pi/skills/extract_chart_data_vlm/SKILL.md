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
  research but never replaces the trusted `execute_dataset_build` publication
  path.
