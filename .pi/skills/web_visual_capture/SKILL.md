---
name: web_visual_capture
description: Capture web page screenshots for visual evidence and chart extraction when structured APIs fail.
---

# Web visual capture

Capture visual evidence from biomedical web pages: `capture_web_page` for
full-page screenshots, `capture_page_section` for precise DOM element crops
(e.g. a figure or table on a paper HTML page).

## When to use

- Visual provenance is required, or structured APIs are unavailable/empty and
  the page visibly carries the data.
- **Do not** use for sources with working structured APIs (PubMed, GEO) unless
  visual provenance is explicitly required.

## How to use

- Screenshots are content-addressed PNGs under source_assets/figures/,
  registered as BROWSER source records.
- Captured figures can feed `extract_chart_data_vlm` for structured chart
  extraction.

## Constraints

- Requests use a real browser User-Agent, stealth scripts, and rate limiting.
- Never substitute screenshots for structured API results when both exist.
