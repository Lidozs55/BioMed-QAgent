/**
 * Fixed-code digit-regularity screen for numeric values extracted from paper
 * sources (anti-fabrication forensics, the "last digit" / "last two digits" /
 * interpolation regularity methods used when auditing published medical data).
 *
 * The screen is conservative by design and fully deterministic:
 *
 * - Genuine measurements distribute approximately uniformly across their final
 *   significant digit, so a strong deviation from uniformity is a fabrication
 *   indicator.
 * - Fabricated series often repeat the same value or fall on a perfectly even
 *   arithmetic progression, which real noisy measurements never do at full
 *   precision.
 * - Every test requires a minimum sample size and an extreme chi-square
 *   threshold (alpha = 0.001); small or borderline samples stay "clean".
 *
 * Only the measured values (typically the y axis of a chart) are screened;
 * ordinal axes such as years are excluded on purpose.
 */

export type DigitAnomalyVerdict = "clean" | "flagged";

export interface DigitAnomalyResult {
  verdict: DigitAnomalyVerdict;
  reasons: string[];
  sample_size: number;
}

/** Below this many values no verdict other than "clean" is ever returned. */
const MIN_SAMPLE_SIZE = 30;

/** Chi-square critical values (upper tail). */
const CHI2_DF9_ALPHA_001 = 27.877;
const CHI2_DF99_ALPHA_001 = 149.449;

/** Minimum sample for the last-two-digit test (100 bins, expected count >= 1.5). */
const MIN_TWO_DIGIT_SAMPLE = 150;

/** A single value repeating this share of the sample is a fabrication indicator. */
const MAX_DUPLICATE_RATIO = 0.8;

/** Longest equal-diff run (on sorted unique values) that is still plausible. */
const MAX_ARITHMETIC_RUN = 10;

/** A perfect arithmetic run needs at least this many points. */
const MIN_ARITHMETIC_POINTS = 11;

function chiSquare(observed: readonly number[], expected: number): number {
  let statistic = 0;
  for (const count of observed) {
    const deviation = count - expected;
    statistic += (deviation * deviation) / expected;
  }
  return statistic;
}

/**
 * Final significant digit of a positive magnitude as printed without trailing
 * zeros, e.g. 12.5 -> 5, 42 -> 2, 1.230 -> 3 (the printed trailing zero is not
 * recoverable from a number and is ignored).
 */
function lastSignificantDigit(value: number): number {
  if (Math.abs(value) === 0) return 0;
  const printed = Math.abs(value)
    .toPrecision(15)
    .replace(/e[+-]\d+$/, "") // strip exponent notation (e.g. 1e-7 -> "1")
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  const last = printed[printed.length - 1];
  return last !== undefined && last >= "0" && last <= "9" ? Number(last) : 0;
}

function lastDigitCounts(values: readonly number[]): number[] {
  const counts = new Array<number>(10).fill(0);
  for (const value of values) {
    counts[lastSignificantDigit(value)] += 1;
  }
  return counts;
}

function longestArithmeticRun(values: readonly number[]): number {
  const unique = [...new Set(values)].sort((left, right) => left - right);
  if (unique.length < MIN_ARITHMETIC_POINTS) return 0;
  let longest = 0;
  let current = 0;
  for (let index = 2; index < unique.length; index += 1) {
    if (
      unique[index] - unique[index - 1] === unique[index - 1] - unique[index - 2]
    ) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export function analyzeDigitAnomaly(values: readonly number[]): DigitAnomalyResult {
  const numeric = values.filter(Number.isFinite);
  const sampleSize = numeric.length;
  if (sampleSize < MIN_SAMPLE_SIZE) {
    return { verdict: "clean", reasons: [], sample_size: sampleSize };
  }

  const allIntegers = numeric.every((value) => value === Math.trunc(value));
  const reasons: string[] = [];

  const digitCounts = lastDigitCounts(numeric);
  const statistic = chiSquare(digitCounts, sampleSize / 10);
  if (statistic > CHI2_DF9_ALPHA_001) {
    reasons.push(
      `last-figure digits deviate strongly from uniform (chi-square ${statistic.toFixed(1)}, ` +
        `df=9, n=${sampleSize})`,
    );
  }
  if (allIntegers && sampleSize >= MIN_TWO_DIGIT_SAMPLE) {
    const pairCounts = new Array<number>(100).fill(0);
    for (const value of numeric) pairCounts[Math.abs(Math.trunc(value)) % 100] += 1;
    const pairStatistic = chiSquare(pairCounts, sampleSize / 100);
    if (pairStatistic > CHI2_DF99_ALPHA_001) {
      reasons.push(
        `last-two-figure digits deviate strongly from uniform (chi-square ` +
          `${pairStatistic.toFixed(1)}, df=99, n=${sampleSize})`,
      );
    }
  }

  const frequency = new Map<number, number>();
  for (const value of numeric) {
    frequency.set(value, (frequency.get(value) ?? 0) + 1);
  }
  const duplicateRatio = Math.max(...frequency.values()) / sampleSize;
  if (duplicateRatio > MAX_DUPLICATE_RATIO) {
    reasons.push(
      `a single value repeats in ${(duplicateRatio * 100).toFixed(0)}% of the sample ` +
        `(n=${sampleSize})`,
    );
  }

  const arithmeticRun = longestArithmeticRun(numeric);
  if (arithmeticRun >= MAX_ARITHMETIC_RUN) {
    reasons.push(
      `values form an arithmetic progression over ${arithmeticRun + 1} points ` +
        `(n=${sampleSize})`,
    );
  }

  if (reasons.length === 0) return { verdict: "clean", reasons: [], sample_size: sampleSize };
  return { verdict: "flagged", reasons: [...new Set(reasons)], sample_size: sampleSize };
}