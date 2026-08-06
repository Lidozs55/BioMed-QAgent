"""Local gene symbol map tests (Phase 3 P1; REVIEW §9.6)."""

from __future__ import annotations

from app.datasets.build.gene_maps import (
    SYMBOL_TO_ENSEMBL,
    resolve_ensembl_to_symbol,
    resolve_symbol_to_ensembl,
    validate_gene_map,
)


def test_local_gene_map_is_valid() -> None:
    assert validate_gene_map() == []
    assert len(SYMBOL_TO_ENSEMBL) >= 2  # fixtures TP53 / BRCA1 are covered


def test_gene_map_resolves_symbol_to_ensembl() -> None:
    assert resolve_symbol_to_ensembl("TP53") == "ENSG00000141510"
    assert resolve_symbol_to_ensembl("BRCA1") == "ENSG00000012048"
    assert resolve_symbol_to_ensembl("NOT_A_GENE") is None


def test_gene_map_resolves_ensembl_to_symbol() -> None:
    assert resolve_ensembl_to_symbol("ENSG00000141510") == "TP53"
    assert resolve_ensembl_to_symbol("ENSG99999999999") is None


def test_gene_map_is_bidirectionally_consistent() -> None:
    for symbol, ensembl_id in SYMBOL_TO_ENSEMBL.items():
        assert resolve_ensembl_to_symbol(ensembl_id) == symbol
