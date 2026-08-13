---
name: pdf_extraction
description: Extract tables and metadata from biomedical research PDFs into the task parsed directory.
---

# PDF table and metadata extraction

Use `extract_pdf_tables` to pull structured tables from a PDF and save them as
CSV files. Use `extract_pdf_metadata` to extract title, authors, DOI, abstract,
captions, and page count.

## When to use

- PDFs acquired via `download_supplementary` or other acquisition paths that
  need structured tabular or bibliographic data.

## How to use

- Both tools save outputs under the task parsed directory.
- If pdfplumber is unavailable, a warning is returned indicating the limited
  accuracy of the regex-based fallback.

## Constraints

- Extracted data is preparation material, not a formal artifact: it may inform
  research but never replaces the trusted `execute_dataset_build` publication
  path.
