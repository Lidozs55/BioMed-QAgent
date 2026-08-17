# Runs Log

Concise log of non-obvious dataset-run outcomes and the decisions behind them.
`code says how; this file says why`. See `docs/ARCHITECTURE.md` for the system
reference.

## 2026-08-17 — gold2 probe-level re-drive (build_egfr_cetuximab_crc_1)

**Build**: `build_egfr_cetuximab_crc_1` · task
`task_ts_51bebe5b-800e-4ab9-bd90-b36214138cad`
**Sources**: GSE140973 + GSE236078 (Agilent 4x44k, GPL10332)
**Final run**: `run_ts_18325315` completed `2026-08-17T09:21:52Z`, `publish`
succeeded.

### Outcome

- `row_granularity: probe_sample_measurement`, `schema_ref:
  gene_expression.probe_long.v1`, primary key `[probe_id, platform_id,
  sample_id]`.
- `row_count = 6,540,765` = GSE140973 (5,072,430) + GSE236078 (1,468,335),
  merged via `append_by_canonical_row`, `conflict_count = 0`.
- Validation `gene_expression.probe_release.v1` → **passed** (10/10 checks;
  only warning-only Benford / last-digit anomalies on `value`).
- Probe→gene mapping shipped as audit reports
  `canonical/*_probe_mapping.csv` (44,495 rows per source, one per distinct
  probe).
- Manifest id `manifest_836b2f96d4856ab6` (sha256 `836b2f96…`); also held in
  `dataset_manifest.json`.

### Why probe-level release (not gene-level)

A gene-level build for GPL10332 is physically un-publishable: the platform has
6,798 features that cannot map to a gene (2,102 control spots, 2,412
ENSEMBL-only, 426 UNIGENE-only, 1 REFSEQ-only, 1,857 unannotated), so
gene-level `coverage == 1.0` is unreachable. Per design D4/D5 (see
`docs/archive/superpowers/specs/2026-08-08-phase5-geo-migration-design.md`),
that is expected, not a bug. The honest path that merges two sources and
publishes is **probe-level (D5 #2)**: every row keeps `geo_probe`
(namespace), and probe→gene mapping is recorded **only** in audit
(`normalization_log` + `probe_mapping.csv`), never promoted into primary rows.

### Two code fixes required

1. `server/src/dataset/canonicalizer/canonicalizer.ts` — the probe branch was
   implementing **D5 #4** semantics (mapped probes flipped to
   `gene_symbol`). Changed to **D5 #2**: under a probe schema a mapped row
   keeps `geo_probe`; the mapping target namespace is written only to the
   normalization log. Pinned by `server/tests/canonicalizer-parity.ts`.

2. `server/src/dataset/service/ts-core.ts` — the runner hardcoded
   `buildGeneExpressionSchema()` as the canonicalizer schema, so a probe spec
   still produced a gene-shaped CSV and every probe row carrying mapped
   targets surfaced as intra-source namespace mixing at
   `compatibility_gate` (`schema_mismatch; namespace_mismatch`). Now the
   schema is resolved from `spec.schema_ref` via the default registry, so a
   probe spec selects the probe schema and `probeSchema = true`.
   Regression-pinned by the probe-level E2E case in
   `server/tests/phase5/ts-core-e2e.test.ts` ("GEO probe-level spec resolves
   the probe schema via spec.schema_ref"): before the fix that spec produced a
   gene-column CSV and the gate rejected it with `schema_mismatch`.

### Footguns hit during the re-drive

- A redrive spec alone does **not** change a build's lineage: the parse op
  hardcodes its adapter output schema. To apply a new schema you must invalidate
  **both** `parse:*` and `canonicalize:*` checkpoints and their
  `state/*_output.json` files (script `_tmp_invalidate_gold2.mjs`).
- Server runs under `tsx watch`; source edits hot-reload, so a failing gate can
  change its `error` between attempts without a process restart.
- `validate_profile` may "succeed" while the profile **status** is `failed`
  (publish then refuses). Read `validation_report.json` / manifest
  `validation_summary.status`, not just the op status.
- **Tech-debt / caveat**: `canonicalize:*` `output_digest` (`09b57b0…`,
  `965f9084…`) is unchanged between the old gene-shaped and new probe-shaped
  outputs, so the digest appears not to cover the row columns. Untangle what the
  canonicalize digest actually covers and make it schema-sensitive.

### Obsolete artifacts to ignore

- `build_state.json` `operation_attempts` keeps every historical attempt
  (gate attempts 5–8 failed with `namespace_mismatch` / `schema_mismatch;`
  before the fixes; publish attempt 1 failed on the gene-level validation
  profile). `completed_operations` is the authoritative terminal set.