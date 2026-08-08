"""Schema Registry tests: registration, lookup and the expression schema."""

from __future__ import annotations

import pytest
from app.datasets.contracts import DatasetSchema, SchemaField
from app.datasets.schema_registry import (
    SchemaRegistry,
    build_gene_expression_schema,
    build_probe_expression_schema,
)


def _schema(schema_id: str = "custom.v1") -> DatasetSchema:
    return DatasetSchema(
        schema_id=schema_id,
        dataset_family="custom",
        row_granularity="custom_row",
        primary_key=["id"],
        fields=[
            SchemaField(
                name="id", data_type="string", semantic_role="row_identifier"
            )
        ],
    )


def test_register_get_contains_list() -> None:
    registry = SchemaRegistry()
    registry.register(_schema())
    assert registry.contains("custom.v1")
    assert registry.get("custom.v1").dataset_family == "custom"
    assert registry.list() == ["custom.v1"]


def test_register_duplicate_with_different_content_rejected() -> None:
    registry = SchemaRegistry()
    registry.register(_schema())
    other = _schema()
    other.fields[0].required = False
    with pytest.raises(ValueError, match="already registered"):
        registry.register(other)


def test_register_same_content_is_idempotent() -> None:
    registry = SchemaRegistry()
    registry.register(_schema())
    registry.register(_schema())  # identical object, no error
    assert registry.list() == ["custom.v1"]


def test_get_unknown_raises() -> None:
    registry = SchemaRegistry()
    with pytest.raises(KeyError, match="not registered"):
        registry.get("missing.v1")


def test_initial_schemas_load_into_registry() -> None:
    registry = SchemaRegistry([_schema()])
    assert registry.contains("custom.v1")


def test_gene_expression_schema_is_complete() -> None:
    schema = build_gene_expression_schema()
    assert schema.schema_id == "gene_expression.long.v1"
    assert schema.dataset_family == "gene_expression"
    assert schema.row_granularity == "gene_sample_measurement"
    assert schema.primary_key == [
        "dataset_id", "sample_id", "gene_id", "measurement_type",
    ]
    names = [field.name for field in schema.fields]
    assert len(names) == len(set(names))
    # The 22-column expression long table is fully covered.
    assert len(names) == 22
    assert "expression_value" in names


def test_gene_expression_semantic_roles() -> None:
    schema = build_gene_expression_schema()
    by_name = {field.name: field for field in schema.fields}
    assert by_name["record_id"].semantic_role == "row_identifier"
    assert by_name["gene_id"].semantic_role == "entity_identifier"
    assert by_name["gene_id"].ontology == "Ensembl/HGNC"
    assert by_name["sample_id"].semantic_role == "foreign_key"
    assert by_name["expression_value"].semantic_role == "measurement"
    assert by_name["expression_value"].unit_policy == "declared_per_record"
    assert by_name["source_line_number"].semantic_role == "provenance"
    # Pathway-member fields belong to another family, not this schema.
    assert "pathway_id" not in by_name


def test_gene_expression_required_fields() -> None:
    schema = build_gene_expression_schema()
    optional = [
        field.name for field in schema.fields if not field.required
    ]
    # gene_id_version is optional by definition; source_sample_alias is optional
    # because single-sample GDC STAR-counts files have no sample column header.
    assert optional == ["gene_id_version", "source_sample_alias"]


def test_probe_expression_schema_registered() -> None:
    """Phase 5 D2: the probe-level contract is a first-class registry schema."""
    schema = build_probe_expression_schema()
    assert schema.schema_id == "gene_expression.probe_long.v1"
    assert schema.dataset_family == "gene_expression"
    assert schema.row_granularity == "probe_sample_measurement"
    assert schema.primary_key == ["probe_id", "platform_id", "sample_id"]
    names = [field.name for field in schema.fields]
    for required in (
        "probe_id",
        "platform_id",
        "sample_id",
        "value",
        "gene_id_namespace",
        "value_semantics",
        "value_scale",
        "expression_unit",
        "is_normalized",
    ):
        assert required in names, f"probe schema must carry {required!r}"
    # Entity-level mirror: gene-level primary columns do not belong here.
    assert "gene_id" not in names
    assert "gene_symbol" not in names
    assert "ensembl_gene" not in names


def test_gene_and_probe_schemas_coexist_in_registry() -> None:
    registry = SchemaRegistry(
        [build_gene_expression_schema(), build_probe_expression_schema()]
    )
    assert registry.contains("gene_expression.long.v1")
    assert registry.contains("gene_expression.probe_long.v1")
    assert (
        registry.get("gene_expression.probe_long.v1").row_granularity
        == "probe_sample_measurement"
    )


def test_probe_schema_primary_key_fields_are_required() -> None:
    schema = build_probe_expression_schema()
    by_name = {field.name: field for field in schema.fields}
    assert by_name["probe_id"].required is True
    assert by_name["platform_id"].required is True
    assert by_name["sample_id"].required is True
    assert by_name["value"].unit_policy == "declared_per_record"
