# Bioactivity measurement retrieval example

This directory is **retrieval only**. It is a static, submitted
`bioactivity_measurement` reference corpus for inspecting a declarative
`FamilySpec`, source facts, and deterministic expected rows.

It is **not a Host fixture**, **not shadow evidence**, and **not E3 evidence**.
The current Host availability is `unavailable`; nothing here is executable or
admitted. This directory contains no DatasetTransform, compiler or bundle
identity, implementation identity, execution receipt, Core result, Publication,
production registration, or activation claim.

## Contents

- `family-spec.example.json` — parsed with the real `@biomed/contracts`
  `parseFamilySpec`, and digested/verified only with
  `computeFamilySpecDigest` / `verifyFamilySpecDigest`.
- `fixtures/input/source-records.json` — the sole factual input carrier.
- `fixtures/expected/*.jsonl` — canonical JSONL rows deterministically derived
  from that same input carrier; no expected scientific value is authored from
  a second source.
- `retrieval-metadata.json` — retrieval/catalog metadata, exact fixture-byte
  hashes, canonical identity rules, and explicit non-execution claims. Its
  catalog block is metadata-only (`kind=family_spec`, `scope=example`,
  `status=submitted`, `executable=false`) and never contains a `value` payload.
- `generate-fixtures.mjs` — explicit writer and digest/identity generator.
- `validate-fixtures.mjs` — read-only, line-by-line verifier.

No contracts source-file hash is recorded. Contract compatibility depends on
calling the public parser/digest APIs, so comments or other non-shape source
changes do not invalidate this corpus.

## Canonical identity rules

All hashes are lowercase SHA-256 (64 hex characters):

1. `asset_id = asset_<sha256(exact fixtures/input/source-records.json bytes)>`.
2. `dataset_id = ds_<sha256(stableStringify(dataset identity body))>`, where
   the body contains the fixed scheme name, the input `source_namespace`, and
   sorted unique accession tokens derived from the input records.
3. `dataset_revision_id = dsrev_<sha256(stableStringify(revision identity body))>`,
   where the body contains the fixed scheme name, computed `dataset_id`, the
   input revision token/provider snapshot, and sorted carrier asset IDs.
4. Expected-output digests are SHA-256 over each exact checked-in JSONL file.
5. `buildId` does not participate in any identity or digest rule.

`stableStringify` is the real canonical JSON API exported by
`@biomed/contracts`; FamilySpec identity uses only the dedicated FamilySpec
APIs listed above.

## Reproduce

From the repository root:

```bash
pnpm --filter @biomed/contracts build
node examples/families/bioactivity-measurement/generate-fixtures.mjs --write
# --write automatically runs the validator
node examples/families/bioactivity-measurement/validate-fixtures.mjs
node examples/families/bioactivity-measurement/generate-fixtures.mjs
```

The final dry run must report `0 file(s) would change`. The validator checks
canonical JSONL and compares every committed output line, in order, with the
row derived from the corresponding input fact.
