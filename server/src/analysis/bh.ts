/**
 * Benjamini-Hochberg FDR adjustment (P5-09 analysis).
 *
 * Exact port of the Python tool helper
 * ``backend/app/skills/builtin/analysis/stats.py::_bh_adjust_pvalues``:
 * BH step-up over the FULL p-value list, preserving input order, with
 * non-finite inputs clamped to 1.0 ("no significance") and a final cap at
 * 1.0 — matching scipy.stats.false_discovery_control(method="bh").
 */

export function bhAdjust(pvals: readonly number[]): number[] {
  const n = pvals.length;
  if (n === 0) return [];
  const values: number[] = pvals.map((p) =>
    Number.isFinite(p) ? p : 1.0,
  );
  if (n === 1) return [Math.min(1.0, values[0])];

  // Stable sort of indices by (value, original index) ascending — identical
  // tie handling to Python's ``sorted(range(n), key=lambda i: (values[i], i))``.
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((i, j) => values[i] - values[j] || i - j);

  const adjusted: number[] = order.map(
    (i, rank) => Math.min(1.0, (values[i] * n) / (rank + 1)),
  );
  // Enforce monotonicity from the largest adjusted value downward.
  for (let rank = n - 2; rank >= 0; rank -= 1) {
    if (adjusted[rank + 1] < adjusted[rank]) {
      adjusted[rank] = adjusted[rank + 1];
    }
  }
  const result = new Array<number>(n).fill(0);
  for (let rank = 0; rank < n; rank += 1) {
    result[order[rank]] = adjusted[rank];
  }
  return result;
}
