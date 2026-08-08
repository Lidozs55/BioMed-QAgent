# T6 Report — Multi-GSE orchestration + bidirectional relations + raise-not-truncate

> Branch: `feat/phase5-geo-migration` · Base: `ba6e779` (T1–T5 + T8)
> Spec: `docs/archive/superpowers/specs/2026-08-08-phase5-geo-migration-design.md`
> §4 D6 (orchestrator + BuildExecutionSummary + build-scoped supersede), D3
> (bidirectional relations), D7 (raise-not-truncate); §5 T6 deliverables.
> Method: TDD red-first (red → fix → green), full backend gates, commit.

## Deliverables

### 1. `MultiBuildOrchestrator` — `backend/app/datasets/build/multi_build.py` (NEW)

- `BuildExecutionSummary` (build_id / status (`BuildResultStatus | None`) /
  `BuildResult` / publication_id / supersedes_publication_id / audit_summary
  (`list[str]` of audit artifact relative paths) / error_message) — **no
  `BuildOutcome` concept**; `BuildResult` is the authoritative business
  result and the summary only aggregates the build_id → BuildResult mapping
  and failure details.
- `MultiBuildResult` — `list[BuildExecutionSummary]`.
- Sequential per-build execution over `list[DatasetBuildSpec]` with
  **failure isolation**: an exception from one build is captured into that
  build's summary (status None + error_message); NO_DATA builds (status
  `no_data`, `publication_id=None`) never roll back or pollute the others.
- **no-supersede assertion**: after the batch, the orchestrator verifies no
  in-batch publication supersedes a publication owned by a different
  build_id, and that each publication_id is owned by exactly one build.
  The mechanical guarantee is the build-scoped supersede lookup (below);
  the assertion is the aggregation-level defense in depth mandated by D6.
- The per-build execution is injected (`RunBuildFn`), keeping the
  orchestrator decoupled from executor wiring — the Phase 7 build API seam.
  `execute_dataset_build` keeps single-build semantics (unchanged).

### 2. Build-scoped supersede — `expression_runner.py` + `invariants.py`

- `find_latest_publication(publish_dir, build_id: str | None = None)`
  filters version directories to `{build_id}_*` when scoped (`None` keeps
  the legacy unscoped scan for callers whose publish dir is per-build by
  construction, e.g. `dataset_build_tool.py`'s `build_root/<build_id>/`).
- `ExpressionBuildRunner._publish` now passes `self._spec.build_id`, so two
  distinct GSE builds sharing one publish directory can never supersede
  each other; same-build re-publishing still chains (build-scoped).
- Existing GDC/Xena single-build publish tests stay green; the old
  cross-build supersede test was rewritten to assert the NEW invariant and
  a within-build supersede guard test was added.

### 3. Bidirectional relations — `artifact_build/relations.py` (shared generator)

- New public `build_source_relations(...)` shared by V1 `source_relations.csv`
  AND the V2 relation audit (V1 alias `_build_source_relations` kept so the
  artifact builder is untouched).
- Every evidenced GSE×PMID pair emits exactly two rows with unique
  `relation_id`s and stable mutual-inverse types:
  - acquired PMID: `article_describes_dataset` (PubMed→GEO) +
    `dataset_described_by_article` (GEO→PubMed);
  - external PMID: `geo_references_pubmed` (GEO→`ext:pubmed:<pmid>`) +
    `pubmed_referenced_by_geo` (`ext:pubmed:<pmid>`→GEO).
- GSE/GSE edges only with explicit `related_series` evidence (both
  directions); external endpoints use stable `ext:geo:<accession>`; a shared
  request is not evidence.
- Dedup key `(from_source_id, to_source_id, relation_type, evidence_type,
  evidence_value)`; rows sorted by that key → stable/byte-identical output.
- V1 validation check (`validation/checks/relations.py`) extended to
  validate the two new inverse relation types (endpoint existence, evidence
  closure, evidence_url ownership), so the pinned pipeline stays `valid`.

### 4. Raise-not-truncate (D7) — `processing/geo_accession.py` (NEW) + wiring

- Shared `extract_gse_accessions` (finditer over the whole input, uppercase,
  dedupe preserving first-occurrence order) and `extract_gse_accession`
  (0 → None; 1 → returned; >1 → explicit ValueError listing ALL accessions
  with a split-into-multiple-V2-builds hint).
- `discovery._resolve_gse` now considers the FULL candidate set across GEO
  queries AND datasets (query GSE1 + dataset GSE2 raises), not first-match.
- `acquisition._extract_gse_accession` delegates to the shared helper.
- `_validate_pipeline_source_specification`'s ≤1 GEO query/dataset rule and
  the V1 allowlist are untouched (existing tests green).

## Tests (red-first)

| Red test file | Coverage |
| --- | --- |
| `tests/pipeline/test_geo_accession_raise_not_truncate.py` (14) | in-string multi-GSE raises listing all; query/dataset cross-field raises; duplicate same-GSE dedup; single unchanged; 0 → None; run_discovery surfaces the raise; acquisition helper |
| `tests/pipeline/test_relations_bidirectional.py` (7) | evidenced pair exactly two rows; external PMID bidirectional; combined 6 rows with type counts; no-evidence no edge; dedup/stable ordering; related_series both directions only with evidence; V1 alias parity |
| `tests/test_dataset_expression_runner.py` (updated +3 new) | no cross-build supersede; within-build supersede preserved; `find_latest_publication(..., build_id=)` scoping |
| `tests/test_dataset_multi_build.py` (5) | two copy-dir fixture builds → distinct build/publication ids, no supersede; failure isolation; NO_DATA isolation; orchestrator raises on cross-build supersede; callback build_id contract |

Existing V1 relation tests updated to bidirectional expectations
(`test_artifact_metadata_correctness.py`).

## Verification (all gates green)

```
cd backend && source .venv/bin/activate
python -m pytest -q            # 2611 passed, 2 skipped, 28 deselected (baseline 2583 passed; +28 net new)
ruff check app/ tests/ launcher.py   # All checks passed
python -c "import app.main"          # OK
```

Frontend untouched.

## Concerns / notes

- `dataset_build_tool.py` was left untouched (not a listed seam): its
  publish directory is per-build by construction (`build_root/<build_id>/`),
  so the legacy unscoped `find_latest_publication` call there is equivalent
  to a build-scoped scan.
- `validation/checks/relations.py` was updated (beyond the listed seam
  files) because the V1 validation check consumes `source_relations.csv`
  directly; without recognizing the new inverse relation types the pinned
  pipeline would fail `source_relation_evidence`. This is a legitimate
  consequence of the relations seam.
- `BuildExecutionSummary.status` is `BuildResultStatus | None`: `None`
  denotes an execution failure (no business `BuildResult` exists), the
  failure detail lives in `error_message`. No new outcome enum was
  introduced (D6 forbids resurrecting `BuildOutcome`).
- GSE/GSE `related_series` evidence enters via the optional
  `related_series` parameter (V1 has a single GSE so no V1 caller passes
  it); endpoints for non-acquired GSEs use `ext:geo:<accession>`.
- `backend/.venv` shows as deleted in the worktree — pre-existing
  environment noise (symlink → real dir), deliberately excluded from the
  commit.
