/**
 * NCBI query simplification — convert natural-language topics to structured
 * queries (Python ``app/integrations/ncbi/query_utils.py`` parity).
 *
 * Converts "METTL5 expression in pancreatic cancer tumor vs normal tissue"
 * into "(METTL5) AND pancreatic cancer". Used by ``search_pubmed`` to avoid
 * NCBI MeSH expansion producing zero-match queries from long natural-language
 * inputs.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
  "in", "and", "or", "the", "of", "for", "with", "a", "an", "by",
  "to", "from", "on", "at", "vs", "versus", "expression",
  "expressions", "normal", "tissue", "tissues", "sample", "samples",
  "tumor", "tumors", "cell", "cells", "line", "lines",
]);

const GENE_TOKEN_RE = /\b([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*\d+)\b/g;

/** Python ``str.split()``: runs of whitespace, no empty tokens. */
function splitWords(value: string): string[] {
  const trimmed = value.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

/** Python ``str.isupper()``: every cased char uppercase, at least one cased. */
function isUpperWord(word: string): boolean {
  return word.toUpperCase() === word && /[A-Za-z]/.test(word);
}

function isGeneToken(word: string): boolean {
  return isUpperWord(word) || /^[A-Z][A-Z0-9]+\d*$/.test(word);
}

/**
 * Extract a structured NCBI query from a natural-language input.
 *
 * Returns the original query unchanged when no gene/disease pattern is
 * detected, so callers can always use this as a drop-in.
 */
export function simplifyNcbiQuery(query: string): string {
  // Strip decorative text: "vs ...", "tumor ..."
  let simplified = query.replace(/\bvs\.?\b.*/i, "").replace(/\btumor\b.*/i, "");
  simplified = simplified.trim().replace(/\.+$/, "");

  // Extract gene-like tokens (METTL5, TP53, BRCA1, etc.)
  const genes = [
    ...new Set(Array.from(simplified.matchAll(GENE_TOKEN_RE), (match) => match[1] ?? "")),
  ];
  const words = splitWords(simplified);
  if (genes.length === 0) {
    return words.length <= 6 ? simplified : query;
  }

  // Extract disease/context words (filter out gene tokens and stopwords)
  const diseaseWords: string[] = [];
  for (const word of words) {
    if (isGeneToken(word)) continue;
    if (STOP_WORDS.has(word.toLowerCase())) continue;
    diseaseWords.push(word);
  }

  if (diseaseWords.length === 0) return genes[0] ?? "";

  const genePart = genes.length > 1 ? genes.slice(0, 2).join(" OR ") : (genes[0] ?? "");
  return `(${genePart}) AND ${diseaseWords.slice(0, 4).join(" ")}`;
}
