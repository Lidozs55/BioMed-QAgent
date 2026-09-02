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
  and registers ONE content-addressed discovery/evidence carrier. Any legacy
  estimated-point review from that call is reject/skip-only under ADR-043.
- `extract_chart_data_vlm` — exploratory extraction into workspace CSV
  staging. It CANNOT publish and its outputs are never formal artifacts.

## Accepted inputs

Governed promotion (`extract_registered_paper_chart_evidence`):

- Pass a task-owned Core source_asset_id returned by Core acquisition,
  `extract_core_archive`, `extract_supplementary_archive`, or another governed
  registration step. For ZIP supplements, first list members with
  `preview_core_asset`, then register each required real member with
  `extract_core_archive`; do not pass the ZIP carrier in place of a required
  PDF/image/table member.
- Registered asset ids only (asset_<sha256>): never absolute paths,
  workspace-relative paths, or browser screenshots.
- One paper full-text XML asset (application/xml or text/xml) and one paper
  PDF asset (application/pdf), plus optional registered supplementary assets.
  Pass extracted member asset IDs in `supplementary_asset_ids` so the evidence
  carrier records member-level Core provenance.

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
  page/figure/bbox and confidence. Legacy point-review facts may still appear
  during migration but do not authorize numeric publication.
- Formal chart-coordinate publication is exact-only. Use VLM output to discover
  figures, panels, series, axes, legends, and locators, then search for an
  explicit numeric source as defined by the PubMed skill. VLM-derived geometry
  is never an exact numeric source.
- The existing estimated-point candidate and HIL path is deprecated and retained
  temporarily only for legacy compatibility while its implementation is removed.
  During this migration, a discovery call may still emit estimated rows or open
  a point-level review. Reject/skip that review, never bind its candidate or
  reviewed carrier, and continue the exact-source search; do not accept,
  correct, or publish those rows. Human review cannot convert digitized or
  model-estimated coordinates into exact values.
- Unclear axis or legend semantics yield an explicit unclear no-points series.
  Clear semantics without explicit numeric source data also yield no points;
  that is an honest skipped-data outcome, not an extraction failure.
- The frozen execution context (system prompt) is binding task semantics for
  which papers and tables are required, but it is never publication authority:
  it does not replace registered carriers, review gates, or the Dataset Core
  publication path.
- If a required carrier, the visual model, or a usable page locator is
  unavailable, return the structured discovery blocker instead of a workspace
  CSV. Point-level review is not required when estimated rows are rejected and
  no exact source exists; report the no-exact-data outcome and continue any
  independently exact records.

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
- During migration, bind a registered VLM carrier as binding kind
  transform_input only when its chart_points table is empty and it contains no
  estimated coordinate rows. Never bind either candidate or reviewed carriers
  that contain estimated points. Future non-empty exact points must come from
  the separately registered numeric source-data carrier. Bind required binary
  supplementary members as binding kind provenance_only; they enter Core
  provenance but never become UTF-8 Host inputs. Do not infer binding kind from
  media type.
- A literature-derived quantitative product uses the tables paper_records,
  experiment_records, primary activity_value_records, chart_series,
  chart_points, and supplementary_asset_records; do not collapse it into a
  generic evidence/papers pair.
- Chart series retain discovery/review status and source locators. Exact chart
  points retain provenance to the explicit numeric asset; absence of exact
  points does not invalidate independently exact table measurements.
- Credential approval, series review, or publication acceptance cannot upgrade
  a visual estimate to an exact measurement.
