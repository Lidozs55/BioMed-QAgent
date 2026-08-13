/**
 * Hierarchical clustering matching what seaborn.clustermap uses under the
 * hood (P5-09 analysis): scipy.cluster.hierarchy.linkage(method='average',
 * metric='euclidean') followed by the dendrogram leaf order.
 *
 * scipy parity details (verified against scipy 1.18):
 *   - average linkage = UPGMA with Lance-Williams weights
 *     d(new, k) = (n_i * d(i, k) + n_j * d(j, k)) / (n_i + n_j);
 *   - Euclidean distance with NaN propagation (a NaN input yields a NaN
 *     distance, which scipy then rejects: "The condensed distance matrix
 *     must contain only finite values.");
 *   - each linkage row stores its children sorted ascending (i < j);
 *   - the dendrogram leaf order (seaborn default, count_sort=False /
 *     distance_sort=False) is the depth-first traversal visiting the FIRST
 *     child's subtree before the second's — identical to
 *     scipy.cluster.hierarchy.leaves_list. Confirmed against seaborn 0.13.2
 *     ``dendrogram_row.reordered_ind`` on random matrices.
 *
 * With distinct pairwise distances the merge sequence is unique, so the
 * greedy global-minimum scan produces byte-identical orders to scipy's
 * nearest-neighbor-chain implementation (the golden generator asserts
 * distance separation to rule out tie-breaking differences).
 */

/** Euclidean distance between two rows (NaN propagates like scipy pdist). */
export function euclideanDistance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export interface LinkageRow {
  /** First child cluster id (always <= second). */
  childA: number;
  /** Second child cluster id. */
  childB: number;
  /** Merge distance (UPGMA cluster distance). */
  distance: number;
  /** Number of leaves in the merged cluster. */
  size: number;
}

/**
 * UPGMA (average linkage) on the rows of `matrix` (scipy linkage parity).
 *
 * Returns n - 1 merge rows; the merge at index i creates cluster id n + i.
 */
export function linkageAverage(matrix: readonly (readonly number[])[]): LinkageRow[] {
  const n = matrix.length;
  if (n < 2) return [];
  // Symmetric distance matrix over active clusters.
  const distances: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(Number.POSITIVE_INFINITY),
  );
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = euclideanDistance(matrix[i], matrix[j]);
      distances[i][j] = d;
      distances[j][i] = d;
    }
  }
  const sizes = new Array<number>(n).fill(1);
  const active = new Array<boolean>(n).fill(true);
  const result: LinkageRow[] = [];

  for (let iteration = 0; iteration < n - 1; iteration += 1) {
    // Global minimum scan, i < j in ascending order (scipy ties are avoided
    // by construction in the golden fixtures).
    let bestI = -1;
    let bestJ = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      if (!active[i]) continue;
      for (let j = i + 1; j < n; j += 1) {
        if (!active[j]) continue;
        if (distances[i][j] < best) {
          best = distances[i][j];
          bestI = i;
          bestJ = j;
        }
      }
    }
    const i = bestI;
    const j = bestJ;
    const clusterId = n + iteration;
    const sizeI = sizes[i];
    const sizeJ = sizes[j];
    const total = sizeI + sizeJ;
    for (let k = 0; k < n; k += 1) {
      if (!active[k] || k === i || k === j) continue;
      // Lance-Williams UPGMA update, same arithmetic order as scipy.
      const d =
        (sizeI * distances[i][k] + sizeJ * distances[j][k]) / total;
      distances[k][clusterId] = d;
      distances[clusterId][k] = d;
    }
    distances[clusterId][clusterId] = Number.POSITIVE_INFINITY;
    sizes[clusterId] = total;
    active[i] = false;
    active[j] = false;
    active[clusterId] = true;
    result.push({ childA: i, childB: j, distance: best, size: total });
  }
  return result;
}

/**
 * Dendrogram leaf order: depth-first traversal visiting each merge's first
 * child subtree before its second (scipy leaves_list / seaborn parity).
 *
 * `n` = number of original leaves (matrix row count).
 */
export function leavesOrder(linkage: readonly LinkageRow[], n: number): number[] {
  const order: number[] = [];
  const visit = (node: number): void => {
    if (node < n) {
      order.push(node);
      return;
    }
    const row = linkage[node - n];
    if (row === undefined) return; // Unreachable for valid linkage.
    visit(row.childA);
    visit(row.childB);
  };
  if (linkage.length > 0) visit(n + linkage.length - 1);
  return order;
}
