---
name: gwas_catalog
description: Find official GWAS Catalog studies and association records through the EMBL-EBI REST API.
---

# GWAS Catalog discovery

Use `lookup_gwas_catalog` to resolve a numeric PubMed ID to exact GCST study
accessions, or to retrieve association records for one GCST accession or rsID.

## Route

- Start with query_type pubmed_id when the request names publications but not
  GWAS Catalog study accessions.
- Use query_type study_accession for all bounded associations in one GCST
  study, or rs_id for associations linked to one verified rsID.
- Preserve the returned P-value components, effect fields, alleles, reported
  genes, mapped genes, counts, and source URLs exactly. A bounded response or
  successful subset never verifies unreturned records. Some association
  relation responses omit a total count; in that case total_count remains null
  rather than being inferred from the returned record count.

## Boundary

Search results are discovery evidence, not formal build carriers. For a Dynamic
Family publication, bind each verified GCST accession or rsID separately to Core
provider gwas-catalog.associations.v1. Missing fields remain null; do not infer
associations or gene mappings from model memory.
