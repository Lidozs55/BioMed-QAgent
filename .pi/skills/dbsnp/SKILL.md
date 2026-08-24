---
name: dbsnp
description: Look up verified RefSNP records by rsID through the official NCBI Variation API.
---

# dbSNP discovery

Use `lookup_dbsnp` to verify one to 20 rs-prefixed identifiers against the
official NCBI RefSNP API.

## How to use

- Pass identifiers in the rs_ids parameter, for example rs429358; bare numeric values and
  guessed identifiers are rejected.
- The tool converts each valid identifier to the official numeric
  `/variation/v0/refsnp/<number>` path and returns compact placement and allele
  fields with the source URL.
- Treat entries in the failures list as unavailable data. Never replace them with
  values recalled from model memory or inferred from another variant.

## Boundary

This tool provides discovery evidence only. It does not create a formal Dataset
Core carrier or add a GWAS dataset family/provider. Formal publication still
requires a registered family and Core acquisition path.
