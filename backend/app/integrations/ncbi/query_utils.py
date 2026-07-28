"""NCBI query simplification — convert natural-language topics to structured queries.

Converts "METTL5 expression in pancreatic cancer tumor vs normal tissue"
into "(METTL5) AND pancreatic cancer". Used by both the pipeline discovery
stage and the search_pubmed skill to avoid NCBI MeSH expansion producing
zero-match queries from long natural-language inputs.
"""

import re

_STOP_WORDS: frozenset[str] = frozenset({
    "in", "and", "or", "the", "of", "for", "with", "a", "an", "by",
    "to", "from", "on", "at", "vs", "versus", "expression",
    "expressions", "normal", "tissue", "tissues", "sample", "samples",
    "tumor", "tumors", "cell", "cells", "line", "lines",
})

_GENE_TOKEN_RE = re.compile(
    r"\b([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*\d+)\b"
)


def simplify_ncbi_query(query: str) -> str:
    """Extract a structured NCBI query from a natural-language input.

    Returns the original query unchanged when no gene/disease pattern is
    detected, so callers can always use this as a drop-in.
    """
    # Strip decorative text: "vs ...", "tumor ..."
    simplified = re.sub(r"\bvs\.?\b.*", "", query, flags=re.IGNORECASE)
    simplified = re.sub(r"\btumor\b.*", "", simplified, flags=re.IGNORECASE)
    simplified = simplified.strip().rstrip(".")

    # Extract gene-like tokens (METTL5, TP53, BRCA1, etc.)
    genes = list(dict.fromkeys(_GENE_TOKEN_RE.findall(simplified)))
    if not genes:
        return simplified if len(simplified.split()) <= 6 else query

    # Extract disease/context words (filter out gene tokens and stopwords)
    disease_words: list[str] = []
    for word in simplified.split():
        if _is_gene_token(word):
            continue
        if word.lower() in _STOP_WORDS:
            continue
        disease_words.append(word)

    if not disease_words:
        return genes[0]

    gene_part = " OR ".join(genes[:2]) if len(genes) > 1 else genes[0]
    disease_part = " ".join(disease_words[:4])
    return f"({gene_part}) AND {disease_part}"


def _is_gene_token(word: str) -> bool:
    return bool(word.isupper() or re.match(r"^[A-Z][A-Z0-9]+\d*$", word))
