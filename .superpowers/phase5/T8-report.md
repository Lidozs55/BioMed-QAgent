# T8 — tumor/normal sample metadata grouping + pairing

**Status**: DONE · **Branch**: `feat/phase5-t8-geo-sample-grouping` (base `245faf3` = T1+T2+T3)
**Commit**: `f06b76f`
**Gates**: full `pytest` 2544 passed (2518 baseline + 26 new), `ruff check app/ tests/ launcher.py` clean, `import app.main` OK, frontend untouched.

## What shipped

1. **`GeoSampleMetadata` contract** (`backend/app/pipeline/processing/geo_tximport.py`)
   - `sample_group: Literal["tumor","normal","unknown"] = "unknown"`
   - `sample_group_raw: str = ""` (hit `key:value`, else `""`)
   - `pairing_id: str | None = None`
   - `group_rule_id: str = GROUP_RULE_ID` (= `"geo.sample-group.v1"`)
   - Defaults keep all existing constructions (6 in tests, parsers) working — no regression.

2. **Versioned extractor `extract_sample_group(characteristics, title, *, rule_id="geo.sample-group.v1") -> SampleGroupResult(sample_group, sample_group_raw, warnings)`** — implements the T8 词汇表 exactly:
   - key normalization: trim / lower / `_`,`-`→space / collapse;
   - high-confidence key priority list: `sample type, tissue type, disease state, condition, tumor normal, tumour normal` (all present hits are same-priority evidence);
   - token matching: multi-word phrases (`primary tumor`, `adjacent normal`, `normal adjacent`, `non-tumor`, `non tumour`, `control tissue`) consumed before single words (`tumor, tumour, cancer, carcinoma, malignant, metastatic` / `normal, healthy`), so `non-tumor` never conflicts with `tumor` and cell-line `control` is never auto-normal;
   - same-priority conflict (any tumor marker + any normal marker in evidence, incl. within one value) → `unknown` + warning, no token-count voting;
   - unrecognized value → `unknown`, no warning, raw `""` (未命中);
   - `sample_group_raw` = highest-priority classified hit `key:value`;
   - low-priority `source name` / `title` evidence only when no high-confidence field, and never for samples declaring a `cell line` characteristic (in-vitro models: fixture titles "Breast Cancer cells" must not classify cell lines as tumor — the fixture regression guard).

3. **`extract_pairing_id(characteristics)`** — explicit keys only (`pair id, pairing id, patient id, subject id, donor id, individual id`); normalized stable `pairing_id`; never from GSM order / title similarity / same-GSE.

4. **`validate_pairings(samples)`** (series-level) — one-sided pairing (no tumor or no normal side) → warning; same `pairing_id` with tumor+normal → valid pair, no warning; `unknown` group never satisfies a side.

5. **Parser wiring** — both `parse_geo_soft_samples` (`_build_sample`) and `parse_geo_series_matrix_samples` populate the four fields via the shared extractors (`group_rule_id="geo.sample-group.v1"`).

6. **Artifact** (`samples.py` + `builder.py` seam) — `sample_metadata.csv` gains `sample_group / sample_group_raw / pairing_id / group_rule_id` columns **only when** `samples_have_group_evidence()` (any non-empty raw or pairing). Cell-line/treatment-only packages (GSE178352 fixture shape) keep the historic base columns byte-identical.

## Red-first tests (`backend/tests/pipeline/test_geo_sample_grouping.py`, 26)

- canonical keys/aliases; case/separator normalization; phrase tokens (`non-tumor`, `adjacent normal`, `primary tumor`, `metastatic`, `carcinoma`, `healthy`);
- same-priority conflict → unknown+warning (incl. within-value `tumor and normal`); raw = earlier-priority key; rule_id override visible in warning;
- unknown value (`condition: treated`) → unknown, no warning, empty raw; absent/non-classification characteristics;
- cell-line `control` NOT auto-normal vs `control tissue` → normal;
- low-priority source-name/title evidence + low-priority conflict warning;
- cell-line skips low-priority evidence (title containing "cancer");
- pairing: all 6 explicit keys, stable normalization (`Patient 1`/`Patient-1`/`PATIENT_ID`), absent pairing, first-key precedence;
- validate_pairings: one-sided warning, tumor+normal valid pair, unknown never satisfies a side, unpaired samples ignored;
- SOFT + series_matrix parser integration (fields populated end-to-end);
- existing cell-line fixture regression (12 samples all stay unknown/empty/no pairing), both at extractor level and artifact level (no extended columns).

## Boundary note (deliberate)

Warnings from `extract_sample_group` / `validate_pairings` are exposed at the extraction layer (result/return value, pinned by tests) but are **not yet wired into `warnings.csv`**: `GeoSampleMetadata` does not retain `characteristics`/`title`, so artifact-time re-derivation cannot reproduce conflict warnings without a new channel. The audit trail is still visible via the artifact columns (`sample_group=unknown` + `sample_group_raw` evidence). Wiring warnings into `warnings.csv` (e.g. a `_build_sample_group_warnings` following the cell-line pattern) is a natural follow-up seam for the T8-final E2E (T2+T8) — left out of scope to keep the change minimal per T8 deliverables.

## Files

- `backend/app/pipeline/processing/geo_tximport.py` (+239) — contract fields, extractors, pairing, validator, parser wiring
- `backend/app/pipeline/stages/artifact_build/samples.py` (+34) — extended columns + `samples_have_group_evidence`
- `backend/app/pipeline/stages/artifact_build/builder.py` (+16) — conditional sample_metadata columns in the write loop
- `backend/tests/pipeline/test_geo_sample_grouping.py` (+545) — red-first tests

T2/T3-owned files (adapters.py, expression_runner.py, chain.py, canonicalizer.py, geo_provider.py, geo_association.py) untouched. Frontend untouched.
