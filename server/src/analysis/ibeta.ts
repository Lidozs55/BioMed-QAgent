/**
 * Incomplete beta / log-gamma special functions (P5-09 analysis).
 *
 * Implements the regularized incomplete beta function I_x(a, b) and log
 * gamma from scratch (Lanczos approximation + modified Lentz continued
 * fraction, after Numerical Recipes §6.4 / §6.2) so the Welch t-test can
 * compute the Student-t survival probability without external dependencies:
 *
 *   P(T > |t|; df) = 0.5 * I_x(df/2, 1/2)  with  x = df / (df + t^2)
 *
 * Accuracy is ~1e-15 relative for the parameter range used by the Welch
 * test (0.5 <= b <= df/2 <= ~1e6, 0 < x < 1), which keeps p-values within
 * the 1e-10 absolute parity tolerance against scipy.special.stdtr.
 */

const FPMIN = 1e-300;
const CF_EPS = 1e-15;
const CF_MAX_ITER = 400;

// Lanczos approximation coefficients (g = 7, n = 9), Numerical Recipes.
const LANCZOS_P = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const;

const HALF_LOG_2PI = 0.9189385332046727; // 0.5 * ln(2 * pi)

/** Natural log of the gamma function for x > 0 (Lanczos, ~1e-15 relative). */
export function lgamma(x: number): number {
  if (x <= 0) {
    // Only positive arguments occur in the Welch path; mirror the usual
    // pole semantics for completeness (reflection is not needed there).
    return Number.NaN;
  }
  if (x < 0.5) {
    // Reflection formula: gamma(x) * gamma(1-x) = pi / sin(pi * x)
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
    );
  }
  const z = x - 1;
  let a = LANCZOS_P[0];
  for (let i = 1; i < LANCZOS_P.length; i += 1) {
    a += LANCZOS_P[i] / (z + i);
  }
  const t = z + 7.5;
  return HALF_LOG_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction of the incomplete beta function (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= CF_MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < CF_EPS) break;
  }
  return h;
}

/**
 * Regularized incomplete beta function I_x(a, b), 0 <= x <= 1.
 *
 * Returns NaN outside [0, 1] (mirrors scipy.special.betainc semantics).
 */
export function betainc(a: number, b: number, x: number): number {
  if (x < 0 || x > 1) return Number.NaN;
  if (x === 0) return 0;
  if (x === 1) return 1;

  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  // Use the series form where it converges fastest, else the symmetry
  // relation I_x(a, b) = 1 - I_{1-x}(b, a).
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Two-sided survival probability of the Student-t distribution:
 * P(|T| > t) for t >= 0 with `df` degrees of freedom.
 */
export function studentTTwoSidedSurvival(t: number, df: number): number {
  if (Number.isNaN(t) || Number.isNaN(df) || df <= 0) return Number.NaN;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  // P(T > |t|) = 0.5 * I_x(df/2, 1/2); two-sided doubles it back.
  return betainc(df / 2, 0.5, x);
}
