---
name: pubmed
description: Search PubMed/NCBI for biomedical literature and download supplementary materials from PMC open-access articles.
---

# PubMed discovery

Search biomedical literature with `search_pubmed` and download supplementary
files with `download_supplementary`.

## When to use

- Finding research papers, abstracts, authors, or supplementary data files in
  the life sciences domain.
- Building the evidence base before selecting expression datasets; literature
  evidence supports the research plan but never enters the expression main
  table.

## How to use

- Query `search_pubmed` with a free-text search string. The JSON payload
  contains paper records with title, abstract, semicolon-separated authors,
  journal, publication date, DOI, PMID, PMCID, and an is_open_access flag.
  total_count reflects PubMed's own hit count and may exceed the number of
  returned records (bounded by max_results).
- Use `download_supplementary` for supplementary material files (.xlsx, .csv,
  .tsv, .txt, .zip, .xls, .docx, .pdf) from the PMC open-access article page
  for a given PMID. The tool first downloads Europe PMC's official
  supplementary ZIP; if none is available, format_hint values full_text_xml or
  publication_pdf identify the publication fallback accurately.
- Zero results: retry with different keywords or field combinations, never the
  same query. Natural-language long queries that return zero hits may be
  retried once in simplified structured form.

## Failure handling

- Failures include an error field in the response — read it, adjust the
  query, and retry once; a network error may be retried without counting
  toward the per-source follow-up budget.
- Three not_found follow-ups on the same source: switch source or move on.

## Formal quantitative evidence builds

- Discovery search, supplementary downloads, PDFs, VLM outputs, and workspace
  CSVs are preparation material, not formal carriers.
- For open-access full text used by a dynamic build, request one exact PMCID per
  source binding with the fixed Core provider `pubmed.files.v1`. Core retrieves
  and provenance-binds Europe PMC XML; never invent another literature provider.
- For supplementary ZIP data used by a formal build, call
  `extract_supplementary_archive` with the verified PMCID. Dataset Core acquires
  the official archive, extracts bounded members without shell/Python/tar, and
  returns derived member asset IDs with parent ZIP hash and member path/hash.
  Use those exact asset IDs as registered inputs; never unpack the workspace
  download yourself.
- Literature-derived quantitative evidence uses the generic six-table topology:
  paper_records, experiment_records, primary activity_value_records,
  chart_series, chart_points, and supplementary_asset_records.
- Preserve raw value, raw unit, relation, original text, source locator,
  extraction method, and confidence.
- Formal quantitative products accept only exact published chart coordinates:
  explicit numeric tokens unambiguously bound to the figure, panel, series,
  dose/condition, and measurement. Search, in order, article tables and text,
  supplementary files, official publisher source data, the paper's Data
  Availability statement, and an author-declared repository/accession. A
  search page may discover a source, but only the registered official or
  author-declared asset supplies formal values.
- Do not digitize raster pixels or vector geometry, interpolate or fit a curve,
  infer points from an IC50, or reconstruct an unstated dilution series. Human
  review can confirm an explicit published token but cannot make an estimate
  exact.
- If the bounded source search finds no exact coordinates, keep chart-series
  discovery and locator facts, leave chart_points empty, and publish the
  independently exact records such as tabulated IC50 values. The final report
  must name the skipped figure/panel, list the searched source classes, state
  that no exact point data were published or found, and recommend that the user
  provide author source data or contact the authors. If exact data are found
  but inaccessible or lack a formal carrier, request the specific upload,
  access, or registration needed instead of substituting estimates.

## Citations

Reported literature findings must carry a PMID (or DOI/PubMed link). Never
present untraceable findings as established conclusions.
