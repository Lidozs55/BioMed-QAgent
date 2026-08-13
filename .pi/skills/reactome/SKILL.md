---
name: reactome
description: Search and fetch biological pathway data from Reactome.
---

# Reactome acquisition

Use `search_reactome` to find pathways by keyword (e.g. "apoptosis", "BRCA"),
`get_pathway` to fetch details by stable ID (e.g. "R-HSA-169893"), and
`download_reactome` to fetch the participants TSV or SBGN diagram for a
pathway.

## When to use

- Pathway questions: biological processes, pathway participants, literature
  references.

## Failure handling

- API failures automatically fall back to a direct page preview with bounded
  visible text; treat that preview as degraded evidence.

## Constraints

- **Research-only source.** Reactome data is for investigation and evidence
  only — never declare `reactome` as a dataset build source. Cite the pathway
  stable ID for every reported pathway finding.
