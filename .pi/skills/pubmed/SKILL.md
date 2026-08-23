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
  for a given PMID.
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
- Literature-derived quantitative evidence uses the generic six-table topology:
  paper_records, experiment_records, primary activity_value_records,
  chart_series, chart_points, and supplementary_asset_records.
- Preserve raw value, raw unit, relation, original text, source locator,
  extraction method, and confidence. The chart_series.human_review_status and
  chart_points.review_status fields are mandatory for chart evidence.
- Estimated or uncertain chart evidence remains human_review_pending until a
  genuine evidence-bound HIL acceptance. Credential-use approval is not a data
  review and cannot release the publication.

## Citations

Reported literature findings must carry a PMID (or DOI/PubMed link). Never
present untraceable findings as established conclusions.
