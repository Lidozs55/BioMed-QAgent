---
name: literature_understanding
description: Analyze paper titles to identify databases, accessions, data types, species, and retrieval queries.
---

# Literature understanding

Use `analyze_papers` to turn paper titles into actionable data-retrieval
targets.

## When to use

- After a literature search step, when titles need to be converted into
  structured findings: database names with accessions, data types, species,
  keywords, and query suggestions.

## How to use

- Pass only paper title strings — never abstracts or other fields.
- Recognized database/accession patterns include GEO (GSE/GSM/GPL), TCGA, GDC,
  Xena, PDB, SRA, EGA, dbGaP, ArrayExpress, PRIDE, and MetaboLights.
- Feed the resulting database/accession pairs into the matching acquisition
  skills (e.g. `search_geo` for a GSE accession).
