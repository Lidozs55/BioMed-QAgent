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

## Citations

Reported literature findings must carry a PMID (or DOI/PubMed link). Never
present untraceable findings as established conclusions.
