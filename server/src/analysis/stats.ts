/**
 * Descriptive statistics matching pandas Series.describe() as used by the
 * Python basic_statistics tool (P5-09 analysis).
 *
 *   - count: non-NaN values
 *   - mean / std: sample mean, sample standard deviation (ddof=1)
 *   - min / max
 *   - q25 / median / q75: linear interpolation quantiles
 *     (``pos = q * (n - 1)``, numpy percentile "linear" semantics)
 *   - missing / missing_pct: NaN count and percentage of the full column
 *
 * All JSON-facing numbers pass through Python's round() semantics
 * (round-half-even) via :func:`pyRound`, and NaN/Inf become null via
 * :func:`safeFloat` — exactly like the Python ``_safe_float`` helper.
 */

/** Sorted ascending copy of the non-NaN values. */
function sortedFinite(values: readonly number[]): number[] {
  const filtered = values.filter((v) => Number.isFinite(v));
  filtered.sort((a, b) => a - b);
  return filtered;
}

/** Linear-interpolation quantile (numpy percentile "linear"). */
function quantile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  if (lo + 1 < n) {
    return sorted[lo] + frac * (sorted[lo + 1] - sorted[lo]);
  }
  return sorted[lo];
}

/**
 * Python round() parity: round-half-even to `digits` decimal places.
 *
 * CPython rounds the EXACT decimal expansion of the binary double, so this
 * extracts up to `digits + 1` fractional digits via toFixed (far more
 * fractional digits than a double's 15-17 significant ones, so the
 * extraction is exact for the magnitudes used here) and applies half-even
 * rounding on the digit string. This matters: 2.675 * 100 rounds to exactly
 * 267.5 in IEEE arithmetic (frac == 0.5 -> half-even would go UP), but
 * Python gives 2.67 because the true binary value is 2.67499...
 */
export function pyRound(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  // Enough fractional digits to expose every significant digit of the
  // double plus the rounding target.
  const expansion = magnitude.toFixed(digits + 20);
  const dot = expansion.indexOf(".");
  const intPart = expansion.slice(0, dot);
  const frac = dot === -1 ? "" : expansion.slice(dot + 1);
  let kept = frac.slice(0, digits).padEnd(digits, "0");
  const next = frac.length > digits ? frac[digits] : "0";
  const tail = frac.slice(digits + 1);
  let roundUp = false;
  if (next > "5") {
    roundUp = true;
  } else if (next === "5") {
    if (/[1-9]/.test(tail)) {
      roundUp = true; // beyond the half point
    } else if (digits === 0) {
      // Exact half: round the integer part to even.
      roundUp = Number(intPart[intPart.length - 1]) % 2 === 1;
    } else {
      // Exact half: round to even (last kept digit).
      roundUp = kept.length > 0 && Number(kept[kept.length - 1]) % 2 === 1;
    }
  }
  let whole = BigInt(intPart);
  if (roundUp) {
    if (digits === 0) {
      whole += 1n;
    } else {
      const scaled = BigInt(intPart) * 10n ** BigInt(digits) + BigInt(kept);
      // padStart keeps the leading zeros BigInt() would otherwise drop
      // (scaled + 1 has fewer digits than `digits` for values < 1).
      const bumped = (scaled + 1n).toString().padStart(digits + 1, "0");
      kept = bumped.slice(-digits);
      whole = BigInt(bumped.slice(0, -digits));
    }
  }
  const result = Number(`${whole}.${digits === 0 ? "0" : kept}`);
  return negative ? -result : result;
}

/**
 * Python ``_safe_float`` parity: null for NaN/Inf/None, else round-half-even
 * to `digits` (default 4).
 */
export function safeFloat(value: number, digits = 4): number | null {
  if (!Number.isFinite(value)) return null;
  return pyRound(value, digits);
}

export interface ColumnStats {
  column: string;
  count: number;
  mean: number | null;
  std: number | null;
  min: number | null;
  q25: number | null;
  median: number | null;
  q75: number | null;
  max: number | null;
  missing: number;
  missing_pct: number;
}

/**
 * pandas Series.describe()-based column statistics (NaN-tolerant).
 *
 * `totalRows` is the full CSV row count — missing_pct is relative to it.
 */
export function describeColumn(
  name: string,
  values: readonly number[],
  totalRows: number,
): ColumnStats {
  const sorted = sortedFinite(values);
  const count = sorted.length;
  const missing = values.length - count;
  let meanValue = Number.NaN;
  let std = Number.NaN;
  if (count > 0) {
    let sum = 0;
    for (const v of sorted) sum += v;
    meanValue = sum / count;
  }
  if (count > 1) {
    let acc = 0;
    for (const v of sorted) {
      const d = v - meanValue;
      acc += d * d;
    }
    std = Math.sqrt(acc / (count - 1));
  }
  return {
    column: name,
    count,
    mean: safeFloat(meanValue),
    std: safeFloat(std),
    min: safeFloat(count > 0 ? sorted[0] : Number.NaN),
    q25: safeFloat(quantile(sorted, 0.25)),
    median: safeFloat(quantile(sorted, 0.5)),
    q75: safeFloat(quantile(sorted, 0.75)),
    max: safeFloat(count > 0 ? sorted[count - 1] : Number.NaN),
    missing,
    missing_pct: pyRound((missing / totalRows) * 100, 2),
  };
}

/**
 * Python float repr used by pandas to_csv (no float_format):
 * integral floats keep a ".0" suffix ("2.0"), NaN becomes "".
 */
export function pyFloatStr(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "";
  if (Number.isInteger(value) && !Object.is(value, -0) && Math.abs(value) < 1e21) {
    return `${value}.0`;
  }
  return String(value);
}
