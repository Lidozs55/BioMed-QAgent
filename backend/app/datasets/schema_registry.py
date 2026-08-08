"""Versioned Schema Registry (ARCHITECTURE §3.3; Design §8.2).

Phase 1 registers the expression long-table schema derived from the V1
``_FIELD_DESCRIPTIONS`` so the 22-column contract stops being a global
protocol and becomes one versioned profile of the ``gene_expression`` family.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.datasets.contracts import DatasetSchema, SchemaField
from app.pipeline.stages.artifact_build.columns import _FIELD_DESCRIPTIONS

# Fields of the V1 22-column expression long table. Pathway fields belong to
# the ``pathway_member`` family and are excluded from the expression schema.
_EXPRESSION_FAMILY_FIELDS: tuple[str, ...] = (
    "record_id",
    "dataset_id",
    "source_id",
    "asset_id",
    "gene_id_raw",
    "gene_id",
    "gene_id_namespace",
    "gene_id_version",
    "sample_id",
    "source_sample_alias",
    "measurement_type",
    "value_semantics",
    "value_scale",
    "is_normalized",
    "is_integer_expected",
    "expression_value",
    "expression_unit",
    "source_logical_file",
    "source_line_number",
    "source_column_index",
    "source_column_name",
    "source_raw_value",
)

_EXPRESSION_PRIMARY_KEY: tuple[str, ...] = (
    "dataset_id",
    "sample_id",
    "gene_id",
    "measurement_type",
)

_FOREIGN_KEY_FIELDS = frozenset({"dataset_id", "source_id", "asset_id", "sample_id"})

# Fields of the Phase 5 D2 probe-level expression contract
# ``gene_expression.probe_long.v1``: an entity-level mirror of the 22-column
# gene schema with ``probe_id``/``platform_id`` replacing the gene primary
# columns.  ``geo_probe`` rows are published only under this contract; the
# gene-level schema never carries them.
_PROBE_EXPRESSION_FIELDS: tuple[str, ...] = (
    "record_id",
    "dataset_id",
    "source_id",
    "asset_id",
    "probe_id",
    "platform_id",
    "sample_id",
    "value",
    "gene_id_namespace",
    "value_semantics",
    "value_scale",
    "expression_unit",
    "is_normalized",
    "is_integer_expected",
    "source_sample_alias",
    "measurement_type",
    "source_logical_file",
    "source_line_number",
    "source_column_index",
    "source_column_name",
    "source_raw_value",
)

_PROBE_PRIMARY_KEY: tuple[str, ...] = ("probe_id", "platform_id", "sample_id")

# Metadata for fields that do not exist in the V1 ``_FIELD_DESCRIPTIONS``
# (or whose probe-level description differs from the gene-level one):
# name -> (data_type, description, semantic_role).
_PROBE_FIELD_META: dict[str, tuple[str, str, str]] = {
    "probe_id": (
        "string",
        "Probe identifier as it appears in the source file (e.g., GEO ID_REF)",
        "entity_identifier",
    ),
    "platform_id": (
        "string",
        "GEO platform accession (GPL...) the probe belongs to",
        "attribute",
    ),
    "value": (
        "float",
        "Numeric expression measurement value parsed from the source file "
        "(probe-level)",
        "measurement",
    ),
    "gene_id_namespace": (
        "string",
        "Namespace of the row identifier: geo_probe for unmapped probes, "
        "or the target gene namespace for successfully mapped rows",
        "entity_identifier",
    ),
}


def _infer_semantic_role(name: str) -> str:
    """Map a V1 column to a Schema semantic role without bespoke per-field tables."""
    if name == "record_id":
        return "row_identifier"
    if name in _FOREIGN_KEY_FIELDS:
        return "foreign_key"
    if name.startswith("gene_id"):
        return "entity_identifier"
    if name == "expression_value":
        return "measurement"
    if name == "expression_unit":
        return "unit"
    if name.startswith("source_"):
        return "provenance"
    return "attribute"


def _infer_ontology(name: str) -> str | None:
    if name == "gene_id":
        return "Ensembl/HGNC"
    return None


def build_gene_expression_schema() -> DatasetSchema:
    """Build ``gene_expression.long.v1`` from the V1 field descriptions."""
    fields: list[SchemaField] = []
    for name in _EXPRESSION_FAMILY_FIELDS:
        data_type, description, unit, nullable, _example = _FIELD_DESCRIPTIONS[name]
        fields.append(
            SchemaField(
                name=name,
                data_type=data_type,
                semantic_role=_infer_semantic_role(name),
                required=nullable == "false",
                unit_policy="declared_per_record" if name == "expression_value" else None,
                ontology=_infer_ontology(name),
                description=description,
                derivation_policy=None,
            )
        )
    # ``source_sample_alias`` mirrors the source column header.  Single-sample
    # GDC STAR-counts files have no sample columns (the sample is implied by
    # the file), so the alias legitimately stays blank there — the V2 schema
    # marks it optional (V1 legacy columns.py is left untouched).
    for field in fields:
        if field.name == "source_sample_alias":
            field.required = False
    return DatasetSchema(
        schema_id="gene_expression.long.v1",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        primary_key=list(_EXPRESSION_PRIMARY_KEY),
        fields=fields,
    )


def build_probe_expression_schema() -> DatasetSchema:
    """Build ``gene_expression.probe_long.v1`` (Phase 5 D2 entity-level mirror).

    The probe-level contract: probe rows are published only under this schema,
    and ``geo_probe`` rows never appear under the gene-level schema.  The
    primary key is ``(probe_id, platform_id, sample_id)``; there is no
    gene-level primary column (``gene_symbol``/``ensembl_gene`` are gene-level
    concepts).
    """
    fields: list[SchemaField] = []
    for name in _PROBE_EXPRESSION_FIELDS:
        meta = _PROBE_FIELD_META.get(name)
        if meta is not None:
            data_type, description, semantic_role = meta
            fields.append(
                SchemaField(
                    name=name,
                    data_type=data_type,
                    semantic_role=semantic_role,
                    required=True,
                    unit_policy="declared_per_record" if name == "value" else None,
                    ontology=_infer_ontology(name),
                    description=description,
                    derivation_policy=None,
                )
            )
            continue
        data_type, description, unit, nullable, _example = _FIELD_DESCRIPTIONS[name]
        fields.append(
            SchemaField(
                name=name,
                data_type=data_type,
                semantic_role=_infer_semantic_role(name),
                required=nullable == "false",
                unit_policy=None,
                ontology=_infer_ontology(name),
                description=description,
                derivation_policy=None,
            )
        )
    # Mirrors the gene schema: the sample alias is blank for single-sample
    # files whose sample is implied by the file itself.
    for field in fields:
        if field.name == "source_sample_alias":
            field.required = False
    return DatasetSchema(
        schema_id="gene_expression.probe_long.v1",
        dataset_family="gene_expression",
        row_granularity="probe_sample_measurement",
        primary_key=list(_PROBE_PRIMARY_KEY),
        fields=fields,
    )


class SchemaRegistry:
    """In-memory versioned registry of canonical dataset schemas."""

    def __init__(self, initial: Iterable[DatasetSchema] = ()) -> None:
        self._schemas: dict[str, DatasetSchema] = {}
        for schema in initial:
            self.register(schema)

    def register(self, schema: DatasetSchema) -> None:
        existing = self._schemas.get(schema.schema_id)
        if existing is not None and existing != schema:
            raise ValueError(f"schema {schema.schema_id!r} already registered")
        self._schemas[schema.schema_id] = schema

    def contains(self, schema_id: str) -> bool:
        return schema_id in self._schemas

    def get(self, schema_id: str) -> DatasetSchema:
        try:
            return self._schemas[schema_id]
        except KeyError as exc:
            raise KeyError(f"schema {schema_id!r} is not registered") from exc

    def list(self) -> list[str]:
        return sorted(self._schemas)
