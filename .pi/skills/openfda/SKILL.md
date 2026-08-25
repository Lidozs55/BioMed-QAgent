---
name: openfda
description: Look up exact MedDRA reaction counts from official openFDA FAERS aggregates.
---

# openFDA FAERS discovery

Use `lookup_openfda_dili_counts` to retrieve current reaction-term counts for
one to 20 generic drug names from the official openFDA drug-event API.

## How to use

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
