---
name: gdc
description: Search, describe, and download NCI GDC datasets (TCGA, TARGET, CPTAC cancer genomics).
---

# GDC acquisition

Use the GDC tools to search the NCI Genomic Data Commons by keyword
(`search_gdc`), inspect project metadata (`describe_gdc`), and download data
files (`download_gdc`).

## When to use

- TCGA, TARGET, or CPTAC cancer genomics questions.
- Raw transcriptomic / genomic / clinical data: RNA-Seq, miRNA-Seq, CNA/CNV,
  methylation, somatic mutations, clinical supplements, slide images, or
  biospecimen data.

## How to use

- Prefer `search_gdc` to discover relevant projects, `describe_gdc` to inspect
  metadata, and `download_gdc` to retrieve files.
- Downloads go to the task raw directory and are tracked in provenance so
  every file is traceable to its GDC origin.
- Gene-level expression matrices from GDC are the preferred fallback when GEO
  probe data lacks usable platform annotations.

## Build boundaries

- One DatasetExecutionSpec per cohort/dataset family; expression data from GDC
  enters the build through the gdc.expression.v1 adapter with
  `source: "gdc"`.
