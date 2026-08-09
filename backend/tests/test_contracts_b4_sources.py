"""B4 contract tests — UniProt/ChEMBL Agent-only research sources.

Locks the "Agent-only" guarantee at the contract layer:
  1. ``Database`` enum gains UNIPROT/CHEMBL members.
  2. Identifier aliases resolve to the new members.
  3. ``SOURCE_CAPABILITIES`` marks them RESEARCH_ONLY (never pipeline_supported).
  4. ``TaskSpecification.declare_sources`` derives research_only declarations.
  5. ``SpecValidator`` rejects a build binding whose source resolves to a
     RESEARCH_ONLY database (reason code ``source_not_pipeline_supported``).
"""

from __future__ import annotations

from app.datasets.contracts import AcquisitionMode, SourceBinding, SourceBindingAcquisition
from app.datasets.schema_registry import SchemaRegistry, build_gene_expression_schema
from app.datasets.spec_validator import SpecValidator
from app.domain.contracts import (
    DATABASE_IDENTIFIER_ALIASES,
    SOURCE_CAPABILITIES,
    Database,
    SourceCapability,
    TaskSpecification,
)
from app.domain.contracts.task import SourceCapabilityDeclaration

# --- 1/2. Enum members + aliases + capability table -------------------------


def test_database_enum_gains_uniprot_and_chembl_members() -> None:
    assert Database.UNIPROT == "uniprot"
    assert Database.CHEMBL == "chembl"


def test_identifier_aliases_resolve_to_new_members() -> None:
    assert DATABASE_IDENTIFIER_ALIASES["uniprot"] is Database.UNIPROT
    assert DATABASE_IDENTIFIER_ALIASES["chembl"] is Database.CHEMBL


def test_new_sources_are_research_only_not_pipeline_supported() -> None:
    assert SOURCE_CAPABILITIES[Database.UNIPROT] is SourceCapability.RESEARCH_ONLY
    assert SOURCE_CAPABILITIES[Database.CHEMBL] is SourceCapability.RESEARCH_ONLY


# --- 3. declare_sources derives research_only declarations ------------------


def test_declare_sources_marks_uniprot_research_only() -> None:
    spec = TaskSpecification.declare_sources(
        topic="drug targets",
        identifiers=["uniprot", "chembl"],
    )
    by_identifier = {
        declaration.identifier: declaration
        for declaration in spec.source_capabilities
    }
    assert isinstance(by_identifier["uniprot"], SourceCapabilityDeclaration)
    assert by_identifier["uniprot"].capability is SourceCapability.RESEARCH_ONLY
    assert by_identifier["chembl"].capability is SourceCapability.RESEARCH_ONLY
    assert "not accepted by the Pipeline" in by_identifier["uniprot"].note


# --- 4. SpecValidator rejects RESEARCH_ONLY build bindings ------------------

_SPEC_BASE: dict[str, object] = {
    "build_id": "build_b4",
    "objective": "compare TP53 expression",
    "dataset_family": "gene_expression",
    "row_granularity": "gene_sample_measurement",
    "schema_ref": "gene_expression.long.v1",
    "validation_profile_ref": "gene_expression.release.v1",
}


def _registry() -> SchemaRegistry:
    return SchemaRegistry([build_gene_expression_schema()])


def _spec(source: str, *, adapter_id: str | None = None) -> dict[str, object]:
    binding = SourceBinding(
        binding_id="binding_b4",
        source=source,
        acquisition=SourceBindingAcquisition(
            mode=AcquisitionMode.BUILTIN, provider_id="gdc.files.v1"
        ),
        adapter_id=adapter_id or "gdc.expression.v1",
        accession="TCGA-COAD",
    )
    return {**_SPEC_BASE, "source_bindings": [binding]}


def test_research_only_source_binding_is_rejected_by_spec_validator() -> None:
    from app.datasets.contracts import DatasetBuildSpec

    result = SpecValidator(
        _registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(DatasetBuildSpec(**_spec("uniprot")))

    assert result.valid is False
    assert "source_not_pipeline_supported" in result.reason_codes


def test_pipeline_supported_source_binding_still_passes() -> None:
    from app.datasets.contracts import DatasetBuildSpec

    result = SpecValidator(
        _registry(),
        allowed_validation_profiles=frozenset({"gene_expression.release.v1"}),
    ).validate(DatasetBuildSpec(**_spec("gdc")))

    assert result.valid is True
    assert "source_not_pipeline_supported" not in result.reason_codes
