"""Local symbol<->Ensembl gene mapping (Phase 3 P1; REVIEW §9.6).

A controlled, package-local subset of HGNC symbols mapped to Ensembl gene
IDs.  Ship-local and deterministic — no online mygene dependency, per the
domestic network stability constraint.  Unmapped symbols are never dropped:
the canonicalizer keeps them in their original namespace and records the
mapped count in batch statistics.

The table is a curated subset covering the demo fixtures and common genes;
production-scale mapping data may replace it behind the same resolution
interface.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

_ENSEMBL_PATTERN = re.compile(r"^ENSG\d{11}$")
_SYMBOL_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.\-]*$")

# symbol -> Ensembl gene ID (without version suffix)
SYMBOL_TO_ENSEMBL: Mapping[str, str] = {
    "TP53": "ENSG00000141510",
    "BRCA1": "ENSG00000012048",
    "BRCA2": "ENSG00000139618",
    "EGFR": "ENSG00000146648",
    "MYC": "ENSG00000136997",
    "PTEN": "ENSG00000171862",
    "KRAS": "ENSG00000133703",
    "ERBB2": "ENSG00000141736",
    "VEGFA": "ENSG00000112715",
    "CDH1": "ENSG00000039068",
    "AKT1": "ENSG00000142208",
    "MTOR": "ENSG00000198793",
    "RB1": "ENSG00000139687",
    "CCND1": "ENSG00000110092",
    "BRAF": "ENSG00000157764",
    "NRAS": "ENSG00000213281",
    "STAT3": "ENSG00000168610",
    "TNF": "ENSG00000232810",
    "IL6": "ENSG00000136244",
    "FOXP3": "ENSG00000049768",
}

_ENSEMBL_TO_SYMBOL: Mapping[str, str] = {
    ensembl_id: symbol for symbol, ensembl_id in SYMBOL_TO_ENSEMBL.items()
}


def resolve_symbol_to_ensembl(symbol: str) -> str | None:
    """Return the mapped Ensembl gene ID for *symbol*, or None when unknown."""
    return SYMBOL_TO_ENSEMBL.get(symbol)


def resolve_ensembl_to_symbol(ensembl_id: str) -> str | None:
    """Return the mapped symbol for *ensembl_id*, or None when unknown."""
    return _ENSEMBL_TO_SYMBOL.get(ensembl_id)


def validate_gene_map() -> list[str]:
    """Return consistency violations of the local map (empty when valid).

    Every key must be a valid gene symbol and every value a valid Ensembl
    gene ID, and no two symbols may map to the same Ensembl ID (many-to-one
    would violate the declared ``keep_all`` aggregation policy's assumptions).
    """
    violations: list[str] = []
    for symbol, ensembl_id in SYMBOL_TO_ENSEMBL.items():
        if not _SYMBOL_PATTERN.fullmatch(symbol):
            violations.append(f"invalid gene symbol key: {symbol!r}")
        if not _ENSEMBL_PATTERN.fullmatch(ensembl_id):
            violations.append(f"invalid Ensembl ID for {symbol!r}: {ensembl_id!r}")
    if len(_ENSEMBL_TO_SYMBOL) != len(SYMBOL_TO_ENSEMBL):
        violations.append("duplicate Ensembl ID maps more than one symbol")
    return violations
