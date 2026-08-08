# Phase 6 — P2-2 Report: DE BH FDR correction + `padj` output (TODO §2.7.4)

> Worktree: isolated (base `main` @ `eceacda`) · TDD red-first → green → gates.
> Scope: `backend/app/skills/builtin/analysis/stats.py` +
> `backend/tests/test_skill_stats.py` only. Frontend untouched.
> Gates: full `pytest -q` green (2641 baseline → 2651 passed, 2 skipped,
> 28 live deselected), `ruff check app/ tests/ launcher.py` clean,
> `python -c "import app.main"` OK.

## Design decision (spec §2.7.4 intent)

- **Ranking stays on the raw p-value; `padj` is reported alongside.**
  Every returned DEG entry gains `padj` = BH FDR-adjusted p-value, but the
  top-N selection and sort order remain keyed on the raw `pvalue`. Rationale:
  (1) the spec explicitly intends "report both, keep ranking on raw p-value";
  (2) raw-p ranking preserves the pre-existing DEG ordering (backward
  compatible — consumers relying on the old top-N order see identical gene
  lists); (3) `padj` adds multiplicity-aware significance for filtering without
  silently reordering results.
- **BH is computed over the FULL p-value set (all genes tested), before any
  top-N truncation** — required so truncated `padj` values remain correct
  FDR estimates for the actual number of hypotheses tested. A top-3-only
  adjustment would understate FDR by ~m/3× (verified: full-set padj ≈ 0.154
  vs top-3-only ≈ 0.045 for the oracle fixture).
- **Significance counts (`significant_up`/`significant_down`) and the per-gene
  `significant` flag are unchanged** — they stay on the raw p-value threshold,
  matching pre-existing behavior. Changing them to `padj` would alter the
  volcano plot labels and published counts beyond the task scope (out of
  scope; noted for a possible follow-up P2).
- **Algorithm**: textbook Benjamini-Hochberg step-up, order-preserving:
  sort ascending, `q(i) = min(1, p(i)·m/i)`, enforce monotonicity from the
  largest, map back to input order — verified bit-consistent with
  `scipy.stats.false_discovery_control(method="bh")` (scipy 1.18) on the
  scipy docstring example and degenerate vectors.
- **NaN-safety / degenerate inputs**: empty → `[]`; single → `[min(1,p)]`;
  all-identical p-values → unchanged (BH minimum sits at `i = m`); non-finite
  values (NaN/Inf) clamped to 1.0 ("no significance") — never crashes, never
  emits NaN/Inf (mirrors the tool's own `p = 1.0` no-test fallback). scipy
  itself *raises* on NaN, so an explicit guard is required; clamping is the
  chosen non-raising behavior (documented in the helper docstring).

## Changes

`backend/app/skills/builtin/analysis/stats.py`:
- New internal helper `_bh_adjust_pvalues(pvals) -> list[float]`
  (internal-helpers section, before Tool 1).
- `run_differential_expression`: computes `padj_list = _bh_adjust_pvalues(
  pval_list)` over the full p-value set before truncation; each DEG record
  gains `"padj": round(adj, 6)` (consistent with `pvalue` rounding).
  Function signature untouched (tool-wrapper backward compatible).
- Docstring updated (BH correction + accurate DEG field list — the old
  docstring said "(strand, log2FC, pvalue)", which never matched the actual
  keys); skill `instructions` now mention `padj`.

`backend/tests/test_skill_stats.py` (10 new tests, red-first):
1. `test_bh_adjust_pvalues_hand_computed` — textbook vector
   `[0.01, 0.02, 0.03, 0.05, 0.20]` → `[0.05, 0.05, 0.05, 0.0625, 0.20]`
   with the full hand computation in the test comment; input-order
   preservation asserted.
2. `test_bh_adjust_pvalues_matches_scipy_oracle` — cross-check against
   scipy's independent `false_discovery_control` on its docstring example.
3. `test_bh_adjust_pvalues_degenerate_inputs` — empty / single / identical /
   NaN / Inf / >1 clamp, no crash.
4. `test_de_entries_carry_padj` — tool-level: every DEG has `padj`,
   `0 <= padj <= 1`, `padj >= pvalue` (BH never lowers a p-value).
5. `test_de_padj_computed_over_all_genes_before_truncation` — 12 genes,
   `top_n=3`; independent oracle (scipy t-test per gene + full-set BH)
   asserts truncated padj equals the FULL-set adjustment, not a top-3-only
   one. Mutation-checked: full-set ≈ 0.154 vs top-3-only ≈ 0.045 → test
   would fail on a truncation-before-BH bug.
6. `test_de_two_genes_only` — m = 2 minimal dataset works.
7. `test_de_identical_pvalues_padj_equals_pvalue` — group-swapped duplicate
   rows produce identical p-values; `padj == pvalue` exactly.
8. `test_de_single_sample_group_padj_safe` — 1-sample groups hit the p = 1.0
   fallback; `padj == 1.0`, no NaN.
9. `test_de_empty_group_raises` — empty group column list still errors
   ("at least one column"), unchanged behavior.
10. `test_de_missing_group_column_raises` — unknown group column still
    errors ("group A columns not found"), unchanged behavior.

## Verification evidence

- RED: `pytest tests/test_skill_stats.py -q` failed at import
  (`cannot import name '_bh_adjust_pvalues'`) before implementation.
- GREEN: `pytest tests/test_skill_stats.py -q` → 16 passed (6 existing + 10 new).
- Full gate: `pytest -q` → **2651 passed, 2 skipped, 28 deselected**
  (baseline 2641 + 10).
- `ruff check app/ tests/ launcher.py` → all checks passed.
- `python -c "import app.main"` → OK.
- `git status --short` → only the two in-scope files modified; frontend
  untouched.

## Concerns / notes

- None blocking. Minor observations: (a) `padj` rounding to 6 decimals
  matches `pvalue`; very small p-values are already truncated to 6 decimals
  by existing behavior (pre-existing, not changed). (b) If a future task
  wants padj-based significance counts, it is a one-line change in
  `significant_up`/`significant_down`/`significant` — deliberately not done
  here to keep behavior backward compatible.
