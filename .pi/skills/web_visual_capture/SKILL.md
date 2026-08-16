---
name: web_visual_capture
description: Capture web page screenshots for visual evidence and chart extraction on any public biomedical web page.
---

# Web visual capture

Capture visual evidence from biomedical web pages: `capture_web_page` for
full-page screenshots, `capture_page_section` for precise DOM element crops
(e.g. a figure or table on a paper HTML page).

## When to use

- Visual provenance is required for a public web page, or the page visibly
  carries data or figures that need to be captured as evidence.
- The capture tools are first-class acquisition tools: call them directly
  whenever visual evidence or chart-extraction input is needed.

## How to use

- Screenshots are content-addressed PNGs under source_assets/figures/,
  registered as BROWSER source records.
- Captured figures can feed `extract_chart_data_vlm` for structured chart
  extraction.

## Constraints

- Requests use a real browser User-Agent, stealth scripts, and rate limiting.
- Never substitute screenshots for structured API results when both exist.
