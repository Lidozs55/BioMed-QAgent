---
name: clinvar
description: Look up total and pathogenic ClinVar variant counts for verified gene symbols.
---

# ClinVar gene counts

Use `lookup_clinvar_counts` for one to 20 HGNC-style gene symbols. The tool
queries official NCBI ClinVar E-utilities twice per symbol:

- `<symbol>[SYM]` for the total count;
- `<symbol>[SYM] AND (pathogenic[CLNSIG] OR likely_pathogenic[CLNSIG])` for the
  pathogenic or likely pathogenic count.

## Rules

- Normalize symbols through a real HGNC source before querying when aliases or
  historical symbols are possible.
- Treat counts as retrieval-time observations, not immutable gene attributes.
- A record is emitted only when both official queries succeed. Use the failures field
  as unavailable data; never complete a partial result from model memory.
- Count summaries do not replace variant-level ClinVar evidence when the user
  asks for individual variants.

## Publication boundary

This tool provides discovery evidence only. IEI publication requires a
registered family/provider and provenance-bound Orphadata, HGNC, ClinVar, and
ClinGen inputs.
