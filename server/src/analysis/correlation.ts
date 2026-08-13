/**
 * Pairwise correlation matrices matching ``pandas.DataFrame.corr`` as used
 * by the Python generate_correlation_matrix tool (P5-09 analysis).
 *
 * Verified against pandas 3.0.3 semantics:
 *   - pearson:  pairwise-complete observations, ddof=1 covariance/std.
 *     No diagonal special case — a constant column yields NaN on the
 *     diagonal too (0/0), and pairs with < 1 common observation are NaN
 *     (min_periods=1).
 *   - spearman: pandas 3.0 ``nancorr_spearman`` — per pair, the common
 *     finite observations are ranked (average ranks, ties included) and
 *     correlated with Pearson, i.e. scipy.spearmanr on the pairwise-masked
 *     subsets (verified against pandas 3.0.3 with a tie + NaN case where
 *     this differs from full-column ranking).
 *   - kendall:  scipy.stats.kendalltau (tau-b) on the pairwise-complete
 *     observations; the diagonal is explicitly 1.0 (pandas sets it before
 *     calling kendalltau), and a constant column yields NaN off-diagonal
 *     (0/0) exactly like scipy.
 */

export type CorrelationMethod = "pearson" | "spearman" | "kendall";

/** Indices where both columns have finite values. */
function commonFiniteIndices(x: readonly number[], y: readonly number[]): number[] {
  const indices: number[] = [];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) indices.push(i);
  }
  return indices;
}

/** Pearson r over the given common indices (ddof=1); NaN for n < 2 or zero variance. */
function pearsonAt(
  x: readonly number[],
  y: readonly number[],
  indices: readonly number[],
): number {
  const n = indices.length;
  if (n < 2) return Number.NaN;
  let mx = 0;
  let my = 0;
  for (const i of indices) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (const i of indices) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return cov / Math.sqrt(vx * vy);
}

/** Average ranks of the values at `indices` (scipy.stats.rankdata("average")). */
function rankAt(
  values: readonly number[],
  indices: readonly number[],
): number[] {
  const n = indices.length;
  const result = new Array<number>(n).fill(Number.NaN);
  // Map row index -> position within `indices` so ranks land in the right slot.
  const positionOfRow = new Map<number, number>();
  indices.forEach((row, position) => positionOfRow.set(row, position));
  const order = [...indices].sort((a, b) => values[a] - values[b]);
  let k = 0;
  while (k < order.length) {
    let end = k + 1;
    while (end < order.length && values[order[end]] === values[order[k]]) end += 1;
    const rank = (k + 1 + end) / 2; // average of the 1-based tie group
    for (let m = k; m < end; m += 1) {
      const position = positionOfRow.get(order[m]);
      if (position !== undefined) result[position] = rank;
    }
    k = end;
  }
  return result;
}

/** Kendall tau-b over the common indices (scipy.stats.kendalltau parity). */
function kendallTauAt(
  x: readonly number[],
  y: readonly number[],
  indices: readonly number[],
): number {
  const n = indices.length;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let p = 0; p < n; p += 1) {
    const xp = x[indices[p]];
    const yp = y[indices[p]];
    for (let q = p + 1; q < n; q += 1) {
      const dx = xp - x[indices[q]];
      const dy = yp - y[indices[q]];
      if (dx === 0 && dy === 0) continue; // tied in both: neither P/Q nor Tx/Ty
      if (dx === 0) {
        tiesX += 1; // x-only tie
        continue;
      }
      if (dy === 0) {
        tiesY += 1; // y-only tie
        continue;
      }
      if (dx * dy > 0) concordant += 1;
      else discordant += 1;
    }
  }
  const denom = Math.sqrt(
    (concordant + discordant + tiesX) * (concordant + discordant + tiesY),
  );
  if (denom === 0) return Number.NaN;
  return (concordant - discordant) / denom;
}

/**
 * Pairwise correlation matrix over the given columns (NaN entries mirror
 * pandas exactly, including the diagonal edge cases).
 */
export function correlationMatrix(
  columns: readonly (readonly number[])[],
  method: CorrelationMethod,
): number[][] {
  const k = columns.length;
  const matrix: number[][] = Array.from({ length: k }, () =>
    new Array<number>(k).fill(Number.NaN),
  );
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      const indices = commonFiniteIndices(columns[i], columns[j]);
      if (indices.length < 1) {
        matrix[i][j] = Number.NaN;
        continue;
      }
      if (method === "kendall") {
        // pandas corr: diagonal short-circuits to 1.0 before kendalltau.
        matrix[i][j] =
          i === j ? 1.0 : kendallTauAt(columns[i], columns[j], indices);
      } else if (method === "spearman") {
        // pandas nancorr_spearman == scipy.spearmanr on the pairwise-masked
        // subsets: rank each masked subset separately, then Pearson.
        const rx = rankAt(columns[i], indices);
        const ry = rankAt(columns[j], indices);
        matrix[i][j] = pearsonOfRanks(rx, ry);
      } else {
        matrix[i][j] = pearsonAt(columns[i], columns[j], indices);
      }
    }
  }
  return matrix;
}

/** Pearson r of two NaN-free rank arrays (length n). */
function pearsonOfRanks(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  if (n < 2) return Number.NaN;
  let mx = 0;
  let my = 0;
  for (let k = 0; k < n; k += 1) {
    mx += x[k];
    my += y[k];
  }
  mx /= n;
  my /= n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let k = 0; k < n; k += 1) {
    const dx = x[k] - mx;
    const dy = y[k] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return cov / Math.sqrt(vx * vy);
}
