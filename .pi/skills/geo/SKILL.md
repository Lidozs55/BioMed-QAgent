---
name: geo
description: Search, describe, and download GEO datasets, including platform annotations for probe-level builds.
---

# GEO acquisition

Find GEO series with `search_geo`, vet candidates with `describe_geo`,
enumerate files with `list_geo_supplementary_files`, download with
`download_geo`, and fetch probe-to-gene annotations with
`download_geo_platform_annotation`.

## Vetting (mandatory before any build)

For each candidate GSE, call `describe_geo` and check that the sample
composition and platform match the research question: sample count,
tumor/normal groups, and platform type (microarray vs RNA-seq). **Unvetted GSE
must not be submitted to `execute_dataset_build`.** Vetting mismatch: pick a
different dataset, do not retry the same accession.

## Probe (microarray) builds

- Probe platforms must declare AdapterParams in the spec binding parameters
  (format, value_semantics, value_scale, expression_unit, platform_ids),
  otherwise geo.expression.v1 rejects the build.
- Gene-level builds from probe data require a GPL platform annotation: pass
  the file from `download_geo_platform_annotation` (gpl from platform_ids in
  the series matrix) via `execute_dataset_build`'s `mapping_files` so probe
  rows map to genes.
- If no usable annotation exists, do not present probe data as gene-level
  results — switch to GDC/Xena gene-level matrices or build at probe level.

## Download discipline

- For supplementary downloads, always specify the filename obtained from
  `list_geo_supplementary_files`.
- Downloads are content-verified source assets tracked in provenance.
- After download, inspect the series matrix for the
  `!series_matrix_table_begin` expression block. Metadata-only files
  (empty_series_matrix) must not be used to build: fetch the family SOFT or
  supplementary counts instead (`download_geo` soft/suppl variants).
- Sample metadata: SOFT files carry `!Sample_*` fields; for tximport or
  supplementary matrices, download the family SOFT and pass it via
  `metadata_files`. Never guess pairing from sample order or title similarity.

## Build boundaries

- One DatasetBuildSpec and one `execute_dataset_build` call per distinct GSE —
  never merge different GSE accessions into a single build; a failed or
  NO_DATA GSE must not block independent builds of the other GSEs.
- Two-stage failure judgment: (a) file has no data table (empty series
  matrix) → switch to soft/suppl, the source is still usable; (b) accession
  has no parseable expression data at all → replace the dataset.
