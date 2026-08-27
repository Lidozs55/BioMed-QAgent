---
name: openfda
description: Look up exact MedDRA reaction counts from official openFDA FAERS aggregates.
---

# openFDA FAERS discovery

## Drug-safety request routing

For a drug-safety request, split the product by dimension and route each one
deterministically:

- MedDRA reaction/report counts for named drugs → `lookup_openfda_dili_counts`
  (this skill). Do not reimplement the openFDA query with scripts, curl, or
  browser downloads.
- DILIrank severity classification or LiverTox evidence → these come only
  from their official sources. When the official source is unreachable,
  report that dimension as structured NO_DATA naming the failure; do not
  substitute third-party mirrors, GitHub copies, or paper-attached replicas.

## How to use

Use `lookup_openfda_dili_counts` to retrieve current reaction-term counts for
one to 20 generic drug names from the official openFDA drug-event API.

- Pass exact MedDRA preferred terms in the reaction terms argument. The tool makes one
  aggregate request per drug, then verifies requested terms omitted by the aggregate
  limit through exact per-term queries.
- Split larger drug lists into batches of at most 20. The process-shared
  limiter protects the unauthenticated openFDA quota.
- Preserve each record's source URL. Counts are live observations and may
  change as FAERS is updated.

## Interpretation boundary

- The matched report count sum is the arithmetic sum across requested PT counts.
  It is not a deduplicated patient or safety-report count because one report
  can contain multiple reaction terms.
- An unmatched term is not reported as zero. Only an explicit official no-match
  response is unmatched; failed fallback verification fails the drug query. Never
  replace either state with a guessed count.
- FAERS counts do not establish causality and do not substitute for DILIrank or
  LiverTox evidence.

## Publication boundary

This is discovery evidence only. Formal drug-safety publication still requires
a registered DILI family, source provider, canonical schema, and validation
profile.
