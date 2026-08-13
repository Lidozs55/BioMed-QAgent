/**
 * Local symbol<->Ensembl gene mapping (Python ``gene_maps.py``; Phase 3 P1;
 * REVIEW 9.6).
 *
 * A controlled, package-local subset of HGNC symbols mapped to Ensembl gene
 * IDs.  Ship-local and deterministic — no online mygene dependency.  Unmapped
 * symbols are never dropped: the canonicalizer keeps them in their original
 * namespace and records the mapped count in batch statistics.
 */

const ENSEMBL_PATTERN = /^ENSG\d{11}$/;
const SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** symbol -> Ensembl gene ID (without version suffix). */
export const SYMBOL_TO_ENSEMBL: Readonly<Record<string, string>> = {
  TP53: "ENSG00000141510",
  BRCA1: "ENSG00000012048",
  BRCA2: "ENSG00000139618",
  EGFR: "ENSG00000146648",
  MYC: "ENSG00000136997",
  PTEN: "ENSG00000171862",
  KRAS: "ENSG00000133703",
  ERBB2: "ENSG00000141736",
  VEGFA: "ENSG00000112715",
  CDH1: "ENSG00000039068",
  AKT1: "ENSG00000142208",
  MTOR: "ENSG00000198793",
  RB1: "ENSG00000139687",
  CCND1: "ENSG00000110092",
  BRAF: "ENSG00000157764",
  NRAS: "ENSG00000213281",
  STAT3: "ENSG00000168610",
  TNF: "ENSG00000232810",
  IL6: "ENSG00000136244",
  FOXP3: "ENSG00000049768",
};

const ENSEMBL_TO_SYMBOL: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SYMBOL_TO_ENSEMBL).map(([symbol, ensemblId]) => [ensemblId, symbol]),
);

/** Return the mapped Ensembl gene ID for ``symbol``, or undefined when unknown. */
export function resolveSymbolToEnsembl(symbol: string): string | undefined {
  return SYMBOL_TO_ENSEMBL[symbol];
}

/** Return the mapped symbol for ``ensemblId``, or undefined when unknown. */
export function resolveEnsemblToSymbol(ensemblId: string): string | undefined {
  return ENSEMBL_TO_SYMBOL[ensemblId];
}

/**
 * Consistency violations of the local map (empty when valid): every key must
 * be a valid gene symbol, every value a valid Ensembl gene ID, and no two
 * symbols may map to the same Ensembl ID (many-to-one would violate the
 * declared ``keep_all`` aggregation policy's assumptions).
 */
export function validateGeneMap(): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const [symbol, ensemblId] of Object.entries(SYMBOL_TO_ENSEMBL)) {
    if (!SYMBOL_PATTERN.test(symbol)) {
      violations.push(`invalid gene symbol key: ${JSON.stringify(symbol)}`);
    }
    if (!ENSEMBL_PATTERN.test(ensemblId)) {
      violations.push(`invalid Ensembl ID for ${JSON.stringify(symbol)}: ${JSON.stringify(ensemblId)}`);
    }
    if (seen.has(ensemblId)) {
      violations.push(`duplicate Ensembl ID maps more than one symbol: ${ensemblId}`);
    }
    seen.add(ensemblId);
  }
  return violations;
}