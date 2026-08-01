"""Contract tests for Pipeline input-level source capabilities (TODO §1.4)."""

from __future__ import annotations

from app.domain.contracts import (
    DATABASE_IDENTIFIER_ALIASES,
    SOURCE_CAPABILITIES,
    Database,
    SourceCapability,
    TaskSpecification,
)


def test_every_database_has_a_declared_capability() -> None:
    """Every canonical Database member must appear in the capability table."""
    declared = set(SOURCE_CAPABILITIES)
    assert declared == set(Database)


def test_pipeline_supported_set_matches_catalog_boundary() -> None:
    """Only the closed-loop sources are pipeline_supported (TODO §1.4).

    Pubmed/GEO/GDC/Xena/Reactome have search→metadata→download→parse→validate
    coverage; PDB/PubChem/browser remain Agent-only research channels.
    """
    supported = {
        database.value
        for database, capability in SOURCE_CAPABILITIES.items()
        if capability is SourceCapability.PIPELINE_SUPPORTED
    }
    assert supported == {"pubmed", "geo", "gdc", "ucsc_xena", "reactome"}
    for database in (Database.PDB, Database.PUBCHEM, Database.BROWSER):
        assert SOURCE_CAPABILITIES[database] is SourceCapability.RESEARCH_ONLY


def test_declare_sources_marks_agent_only_identifiers() -> None:
    """Agent-only identifiers are declared research_only, not silently accepted."""
    spec = TaskSpecification.declare_sources(
        topic="mixed",
        identifiers=["pubmed", "geo", "pdb", "pubchem", "browser"],
    )
    by_identifier = {decl.identifier: decl for decl in spec.source_capabilities}
    assert by_identifier["pubmed"].capability is SourceCapability.PIPELINE_SUPPORTED
    assert by_identifier["geo"].capability is SourceCapability.PIPELINE_SUPPORTED
    for identifier in ("pdb", "pubchem", "browser"):
        assert by_identifier[identifier].capability is SourceCapability.RESEARCH_ONLY
        assert "not accepted by the Pipeline" in by_identifier[identifier].note


def test_declare_sources_resolves_xena_alias_to_canonical_database() -> None:
    """Both 'xena' and 'ucsc_xena' resolve to Database.UCSC_XENA."""
    spec = TaskSpecification.declare_sources(
        topic="xena",
        identifiers=["xena", "ucsc_xena"],
    )
    assert [decl.database for decl in spec.source_capabilities] == [Database.UCSC_XENA]


def test_declare_sources_marks_unknown_identifier_pending() -> None:
    """Unknown identifiers are declared pending with a null database."""
    spec = TaskSpecification.declare_sources(
        topic="unknown",
        identifiers=["not_a_database"],
    )
    assert spec.source_capabilities[0].capability is SourceCapability.PENDING
    assert spec.source_capabilities[0].database is None
    assert spec.source_capabilities[0].identifier == "not_a_database"


def test_identifier_aliases_cover_catalog_user_selectable_sources() -> None:
    """Every user-selectable source id in the builtin catalog is resolvable."""
    assert DATABASE_IDENTIFIER_ALIASES["xena"] is Database.UCSC_XENA
    assert DATABASE_IDENTIFIER_ALIASES["ucsc_xena"] is Database.UCSC_XENA
    for identifier in ("pubmed", "geo", "gdc", "pdb", "reactome", "pubchem"):
        assert identifier in DATABASE_IDENTIFIER_ALIASES


def test_declare_sources_is_round_trip_serializable() -> None:
    """The capability declaration survives Pydantic serialization."""
    spec = TaskSpecification.declare_sources(
        topic="round trip",
        identifiers=["pubmed", "pdb"],
    )
    restored = TaskSpecification.model_validate_json(spec.model_dump_json())
    assert restored.source_capabilities == spec.source_capabilities
