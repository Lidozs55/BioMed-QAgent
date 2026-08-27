---
name: xena
description: Search and download public genomics datasets from the UCSC Xena data hub.
---

# Xena acquisition

Use `search_xena` to discover datasets by term (cohort name, data type) and
`download_xena` to retrieve individual files (.tsv.gz or .json).

## When to use

- UCSC Xena public data hub questions: TCGA cohorts, cancer genomics,
  gene-expression / clinical / mutation datasets.

## How to use

- Discover first, then download specific files; downloads go to the task raw
  directory and are tracked in provenance.
- Gene-level matrices from Xena are the preferred fallback when GEO probe data
  lacks usable platform annotations.

## Build boundaries

- Expression matrices enter the build through the xena.matrix.v1 adapter with
  `source: "ucsc_xena"`. One DatasetExecutionSpec per cohort/dataset family.
