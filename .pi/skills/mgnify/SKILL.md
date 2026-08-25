---
name: mgnify
description: Search official MGnify study metadata through its JSON API without browser rendering.
---

# MGnify study discovery

Use `search_mgnify_studies` to search the official MGnify JSON API by disease,
phenotype, biome, or study keyword. This path avoids the dynamic browse page,
which can fail independently of the API.

## Rules

- Preserve the study accession, source and publications URLs, sample count,
  BioProject ID, and source abstract exactly as returned.
- Retry with a narrower disease or cohort term when results are broad. Do not
  infer that every text match is a human case-control study.
- Study metadata does not contain differential abundance estimates. Never
  invent species, effect sizes, prevalence, odds ratios, or p-values from it.
- When GMRepo or another requested source is unavailable, report that source as
  unavailable and continue only with independently retrieved real evidence,
  such as MGnify records or paper supplementary files.

## Publication boundary

This tool provides discovery metadata only. Formal microbiome publication
requires a registered family/provider and evidence-bound abundance or
association tables.
