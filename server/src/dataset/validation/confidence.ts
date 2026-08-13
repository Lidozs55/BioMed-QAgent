/**
 * Deterministic statistical confidence detectors (Phase 6; Python
 * ``backend/app/datasets/build/confidence.py``).
 *
 * Pure, side-effect-free detectors that flag "passes validation yet
 * implausible" numeric columns (SURVEY §4.1). They are a supplementary
 * signal on top of the validation gate, never a replacement for it: findings
 * are written to ``confidence_report.csv`` and surfaced as warnings, they do
 * not block release in the v1 policy (SURVEY §7 — warning only until
 * thresholds are calibrated).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { csvLine } from "../adapters/text.js";

/** Detector thresholds, owned by the validation profile (Python dataclass). */
export interface ConfidenceThresholds {
  min_benford_samples: number;
  benford_min_order_span: number;
  benford_chi2_limit: number;
  min_last_digit_samples: number;
  last_digit_chi2_limit: number;
  progression_max_distinct: number;
}

export function defaultConfidenceThresholds(): ConfidenceThresholds {
  return {
    min_benford_samples: 30,
    benford_min_order_span: 2,
    benford_chi2_limit: 15.51,
    min_last_digit_samples: 50,
    last_digit_chi2_limit: 16.92,
    progression_max_distinct: 200,
  };
}

/** One detector's verdict for one numeric column. */
export interface DetectorFinding {
  column: string;
  detector: string;
  applicable: boolean;
  statistic: number | null;
  anomaly: boolean;
  detail: string;
}

/** Aggregated per-column detector findings (the confidence contract). */
export interface ConfidenceSummary {
  findings: DetectorFinding[];
  anomaly_count: number;
}

export function anomaliesOf(summary: ConfidenceSummary): DetectorFinding[] {
  return summary.findings.filter((finding) => finding.anomaly);
}

const BENFORD_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function benfordExpected(digit: number): number {
  return Math.log10(1 + 1 / digit);
}

const LAST_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const REL_TOL = 1e-6;

/** Parse to finite floats; non-numeric / non-finite entries are skipped. */
function asFloats(values: readonly (number | string)[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) out.push(value);
      continue;
    }
    if (typeof value !== "string") continue;
    const parsed = pythonFloat(value);
    if (parsed.ok && Number.isFinite(parsed.value)) out.push(parsed.value);
  }
  return out;
}

type FloatParse = { ok: true; value: number } | { ok: false };

/** Python ``float()``-compatible strict parse for detector inputs. */
function pythonFloat(value: string): FloatParse {
  const text = value.trim();
  if (text === "") return { ok: false };
  const lower = text.toLowerCase();
  if (lower === "nan") return { ok: true, value: Number.NaN };
  if (lower === "inf" || lower === "+inf" || lower === "infinity" || lower === "+infinity") {
    return { ok: true, value: Number.POSITIVE_INFINITY };
  }
  if (lower === "-inf" || lower === "-infinity") {
    return { ok: true, value: Number.NEGATIVE_INFINITY };
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    return { ok: true, value: Number(text) };
  }
  return { ok: false };
}

/**
 * Python ``format(abs(v), "f")``-equivalent fixed-point expansion.  JS
 * ``toFixed`` switches to exponential above 1e21; Python's ``f`` format does
 * not, so values at or above that magnitude are expanded from the shortest
 * exponential representation (those values are exact integers in IEEE-754).
 */
function formatFixed(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1e21) return absolute.toFixed(6);
  const [mantissa, exponentText] = absolute.toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  const integerDigits = exponent + 1;
  if (integerDigits >= digits.length) {
    return digits + "0".repeat(integerDigits - digits.length) + ".000000";
  }
  return (
    digits.slice(0, integerDigits) +
    "." +
    digits.slice(integerDigits) +
    "000000".slice(digits.length - integerDigits)
  );
}

/**
 * Last digit of *value*'s decimal representation, exponent-expanded.
 * ``1.5e7`` expands to ``15000000.0`` -> last digit 0; ``1.23`` -> 3; zeros
 * before the decimal point keep their signal (many 0/5 endings is the
 * artifact we want to catch, SURVEY §4.1B).
 */
function lastDecimalDigit(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const text = formatFixed(Math.abs(value)).replace(/0+$/, "").replace(/\.$/, "");
  if (text.length === 0) return null;
  const last = text[text.length - 1];
  return /^\d$/.test(last) ? Number(last) : null;
}

/**
 * Whether Benford first-digit detection is meaningful for *values*: enough
 * samples, no negatives, a value range spanning at least two orders of
 * magnitude, and data not normalized into [0, 1] (SURVEY §4.1A, §7).
 */
export function isBenfordApplicable(
  values: readonly (number | string)[],
  thresholds: ConfidenceThresholds = defaultConfidenceThresholds(),
): boolean {
  const parsed = asFloats(values);
  if (parsed.length < thresholds.min_benford_samples) return false;
  if (parsed.some((value) => value < 0)) return false;
  const positive = parsed.filter((value) => value > 0);
  if (positive.length === 0) return false;
  const low = Math.min(...positive);
  const high = Math.max(...parsed);
  if (low <= 0 || high / low < 10 ** thresholds.benford_min_order_span) return false;
  return high > 1.0;
}

/** Chi-squared distance of the first-digit distribution from Benford. */
export function benfordDistance(
  values: readonly (number | string)[],
  _thresholds: ConfidenceThresholds = defaultConfidenceThresholds(),
): number {
  void _thresholds;
  const observed = new Map<number, number>();
  let total = 0;
  for (const value of asFloats(values)) {
    if (value <= 0) continue;
    const firstDigit = Number(Math.abs(value).toExponential()[0]);
    observed.set(firstDigit, (observed.get(firstDigit) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return 0;
  let chi2 = 0;
  for (const digit of BENFORD_DIGITS) {
    const expected = total * benfordExpected(digit);
    const count = observed.get(digit) ?? 0;
    chi2 += (count - expected) ** 2 / expected;
  }
  return chi2;
}

/** Chi-squared statistic for last-digit uniformity (digits 0-9). */
export function lastDigitChi2(
  values: readonly (number | string)[],
  _thresholds: ConfidenceThresholds = defaultConfidenceThresholds(),
): number {
  void _thresholds;
  const observed = new Map<number, number>();
  let total = 0;
  for (const value of asFloats(values)) {
    const digit = lastDecimalDigit(value);
    if (digit === null) continue;
    observed.set(digit, (observed.get(digit) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return 0;
  const expected = total / LAST_DIGITS.length;
  let chi2 = 0;
  for (const digit of LAST_DIGITS) {
    const count = observed.get(digit) ?? 0;
    chi2 += (count - expected) ** 2 / expected;
  }
  return chi2;
}

/** True when every value equals the first (relative tolerance). */
export function detectConstantColumn(
  values: readonly (number | string)[],
  _thresholds: ConfidenceThresholds = defaultConfidenceThresholds(),
): boolean {
  void _thresholds;
  const parsed = asFloats(values);
  if (parsed.length < 2) return false;
  const first = parsed[0];
  return parsed.every(
    (value) => Math.abs(value - first) <= REL_TOL * Math.max(1.0, Math.abs(first)),
  );
}

/**
 * True when the sorted distinct values form an equal-spaced sequence (SURVEY
 * §4.1C). Only enabled when the number of distinct values is small.
 */
export function detectArithmeticProgression(
  values: readonly (number | string)[],
  thresholds: ConfidenceThresholds = defaultConfidenceThresholds(),
): boolean {
  const parsed = [...new Set(asFloats(values))].sort((a, b) => a - b);
  if (parsed.length < 3 || parsed.length > thresholds.progression_max_distinct) {
    return false;
  }
  const steps = new Set<number>();
  for (let index = 0; index < parsed.length - 1; index += 1) {
    steps.add(parsed[index + 1] - parsed[index]);
  }
  if (steps.size === 0 || steps.has(0)) return false;
  const firstStep = steps.values().next().value as number;
  return [...steps].every(
    (step) => Math.abs(step - firstStep) <= REL_TOL * Math.max(1.0, Math.abs(firstStep)),
  );
}

/** Run the applicable detectors over every numeric column. */
export function aggregateConfidenceMetrics(
  columns: Readonly<Record<string, readonly (number | string)[]>>,
  thresholds: ConfidenceThresholds = defaultConfidenceThresholds(),
): ConfidenceSummary {
  const findings: DetectorFinding[] = [];
  for (const column of Object.keys(columns).sort()) {
    const columnValues = columns[column];
    const parsed = asFloats(columnValues);
    if (parsed.length === 0) {
      findings.push({
        column,
        detector: "no_numeric_values",
        applicable: false,
        statistic: null,
        anomaly: false,
        detail: "column has no finite numeric values",
      });
      continue;
    }

    if (isBenfordApplicable(columnValues, thresholds)) {
      const distance = benfordDistance(columnValues, thresholds);
      findings.push({
        column,
        detector: "benford_distance",
        applicable: true,
        statistic: distance,
        anomaly: distance > thresholds.benford_chi2_limit,
        detail: `first-digit chi2=${distance.toFixed(3)}, limit=${thresholds.benford_chi2_limit}`,
      });
    } else {
      findings.push({
        column,
        detector: "benford_distance",
        applicable: false,
        statistic: null,
        anomaly: false,
        detail: "is_benford_applicable returned False",
      });
    }

    if (parsed.length < thresholds.min_last_digit_samples) {
      findings.push({
        column,
        detector: "last_digit_chi2",
        applicable: false,
        statistic: null,
        anomaly: false,
        detail:
          `fewer than ${thresholds.min_last_digit_samples} numeric values; ` +
          "chi-squared last-digit test not applicable",
      });
    } else {
      const chi2 = lastDigitChi2(columnValues, thresholds);
      findings.push({
        column,
        detector: "last_digit_chi2",
        applicable: true,
        statistic: chi2,
        anomaly: chi2 > thresholds.last_digit_chi2_limit,
        detail: `last-digit chi2=${chi2.toFixed(3)}, limit=${thresholds.last_digit_chi2_limit}`,
      });
    }

    const constant = detectConstantColumn(columnValues, thresholds);
    findings.push({
      column,
      detector: "constant_column",
      applicable: true,
      statistic: null,
      anomaly: constant,
      detail: constant ? "all values identical within tolerance" : "values vary",
    });

    const progression = detectArithmeticProgression(columnValues, thresholds);
    findings.push({
      column,
      detector: "arithmetic_progression",
      applicable: true,
      statistic: null,
      anomaly: progression,
      detail: progression
        ? "distinct values form an equal-spaced sequence"
        : "no equal-spaced sequence",
    });
  }
  const anomalyCount = findings.filter((finding) => finding.anomaly).length;
  return { findings, anomaly_count: anomalyCount };
}

const REPORT_HEADER = ["column", "detector", "applicable", "statistic", "anomaly", "detail"];

/** Deterministically write *summary* findings to a CSV report. */
export function writeConfidenceReport(summary: ConfidenceSummary, path: string): void {
  const dir = dirname(path);
  if (dir.length > 0) mkdirSync(dir, { recursive: true });
  const lines = [csvLine(REPORT_HEADER)];
  for (const finding of summary.findings) {
    lines.push(
      csvLine([
        finding.column,
        finding.detector,
        finding.applicable ? "true" : "false",
        finding.statistic === null ? "" : finding.statistic.toFixed(6),
        finding.anomaly ? "true" : "false",
        finding.detail,
      ]),
    );
  }
  writeFileSync(path, lines.join(""), "utf8");
}