/**
 * Two-sided Welch t-test matching scipy.stats.ttest_ind(..., equal_var=False)
 * on both the t statistic and the p-value (P5-09 analysis).
 *
 * scipy 1.18 computes, per group, the ddof=1 sample variance
 * ``v = sum((x - mean)^2) / (n - 1)`` and then
 *
 *     se2  = v1/n1 + v2/n2
 *     t    = (m1 - m2) / sqrt(se2)
 *     df   = se2^2 / ((v1/n1)^2/(n1-1) + (v2/n2)^2/(n2-1))
 *     p    = 2 * P(T > |t|) = I_x(df/2, 1/2),  x = df / (df + t^2)
 *
 * Degenerate inputs mirror the guard used by the Python analysis tool
 * (backend/app/skills/builtin/analysis/stats.py): a group with fewer than 2
 * values or with zero population variance (np.std ddof=0 == 0) never reaches
 * scipy and yields p = 1.0 (t is reported as NaN, the value scipy itself
 * would produce for those inputs). Callers that need raw scipy semantics for
 * the degenerate cases must implement the guard themselves.
 */

import { studentTTwoSidedSurvival } from "./ibeta.js";

export interface WelchResult {
  /** Welch t statistic (NaN for degenerate inputs). */
  t: number;
  /** Two-sided p-value (1.0 for degenerate inputs). */
  p: number;
}

/** Mean of a finite non-empty sample. */
function mean(values: number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Sample variance ddof=1 (scipy _var with ddof=1); NaN when n < 2. */
function sampleVariance(values: number[], sampleMean: number): number {
  const n = values.length;
  if (n < 2) return Number.NaN;
  let sum = 0;
  for (const value of values) {
    const d = value - sampleMean;
    sum += d * d;
  }
  return sum / (n - 1);
}

/**
 * Population standard deviation (ddof=0) — the exact guard the Python tool
 * uses (``np.std(a)`` defaults to ddof=0).
 */
function populationStd(values: number[], sampleMean: number): number {
  let sum = 0;
  for (const value of values) {
    const d = value - sampleMean;
    sum += d * d;
  }
  return Math.sqrt(sum / values.length);
}

/**
 * Two-sided Welch t-test (scipy.stats.ttest_ind equal_var=False parity).
 *
 * Inputs must already be NaN-free (the caller performs dropna exactly like
 * the Python tool does per gene row).
 */
export function welchTTest(a: number[], b: number[]): WelchResult {
  const na = a.length;
  const nb = b.length;
  const meanA = na > 0 ? mean(a) : Number.NaN;
  const meanB = nb > 0 ? mean(b) : Number.NaN;

  // Python tool guard: ttest_ind is only called when both groups have at
  // least 2 values AND non-zero population variance; otherwise p = 1.0.
  if (
    na < 2 || nb < 2 ||
    !Number.isFinite(meanA) || !Number.isFinite(meanB) ||
    populationStd(a, meanA) === 0 || populationStd(b, meanB) === 0
  ) {
    return { t: Number.NaN, p: 1.0 };
  }

  const varA = sampleVariance(a, meanA);
  const varB = sampleVariance(b, meanB);
  const se2 = varA / na + varB / nb;
  const t = (meanA - meanB) / Math.sqrt(se2);
  const vnA = varA / na;
  const vnB = varB / nb;
  const df = (se2 * se2) / ((vnA * vnA) / (na - 1) + (vnB * vnB) / (nb - 1));
  const p = studentTTwoSidedSurvival(Math.abs(t), df);
  return { t, p };
}
