"""Column definitions and field descriptions for artifact CSVs.

Centralizes the schema of every CSV written to the staging package so the
builder modules can reference a single source of truth (TODO §1.2, §1.7).
"""
from __future__ import annotations

_ARTIFACT_COLUMNS: dict[str, list[str]] = {
    "literature.csv": [
        "source_id", "pmid", "pmcid", "doi", "title", "authors",
        "journal", "published_at", "source_url", "retrieved_at",
    ],
    "dataset_catalog.csv": [
        "dataset_id", "source_id", "database", "accession", "title",
        "organism", "experiment_type", "sample_count", "platform_ids",
        "related_pmids", "source_url", "retrieved_at",
    ],
    "sample_metadata.csv": [
        "sample_id", "dataset_id", "source_id", "source_sample_alias",
        "cell_line_raw", "cell_line_canonical", "normalization_rule",
        "treatment", "replicate", "organism", "source_url",
    ],
    "field_descriptions.csv": [
        "field_name", "data_type", "description", "unit", "nullable",
        "source", "example",
    ],
    "field_mapping.csv": [
        "dataset_id", "source_id", "raw_field", "canonical_field", "conversion",
        "confidence", "notes",
    ],
    "cleaning_report.csv": [
        "rule", "field_name", "affected_count", "message",
    ],
    "source_list.csv": [
        "source_id", "database", "accession", "url", "title", "retrieved_at",
    ],
    "source_relations.csv": [
        "relation_id", "from_source_id", "to_source_id", "relation_type",
        "evidence_type", "evidence_value", "evidence_url",
    ],
    "source_assets.csv": [
        "asset_id", "source_id", "successful_attempt_id", "data_level",
        "relative_path", "size_bytes", "sha256", "media_type", "schema_version",
    ],
    "download_log.csv": [
        "attempt_id", "source_id", "url", "status", "bytes_received",
        "error_code", "error_message", "started_at", "finished_at",
    ],
    "processing_log.csv": [
        "step_id", "stage_attempt_id", "stage", "operation", "input_refs",
        "output_refs", "tool_version", "rows_before", "rows_after",
        "parameters", "status", "started_at", "finished_at", "warnings",
    ],
    "warnings.csv": [
        "warning_id", "severity", "stage", "code", "message",
        "source_id", "asset_id", "record_id", "created_at",
    ],
}

_REACTOME_COLUMNS = {
    "record_id", "dataset_id", "source_id", "asset_id", "pathway_id",
    "pathway_name", "participant_id", "participant_name", "participant_type",
    "species", "interaction_type", "source_logical_file", "source_line_number",
    "source_column_index", "source_column_name", "source_raw_value",
}

# Multi-source manifest columns (TODO §1.5.4): dataset_id → database →
# row_count, one row per input dataset of a deterministic merge.
_MULTI_SOURCE_MANIFEST_COLUMNS = [
    "dataset_id", "database", "accession", "source_id", "row_count",
]


# Real semantic descriptions for every field in main_data.csv (TODO §1.2).
# Replaces the placeholder ``field.replace("_", " ")`` that produced strings
# like ``"gene id namespace"``. Each entry is
# ``(data_type, description, unit, nullable, example)``.
_FIELD_DESCRIPTIONS: dict[str, tuple[str, str, str, str, str]] = {
    "pathway_id": (
        "string",
        "Reactome stable identifier for the pathway containing the participant",
        "", "false", "R-HSA-199420",
    ),
    "pathway_name": (
        "string",
        "Display name of the Reactome pathway containing the participant",
        "", "false", "Apoptosis",
    ),
    "participant_id": (
        "string",
        "Stable identifier of the Reactome physical entity or event participating in the pathway",
        "", "false", "R-HSA-109581",
    ),
    "participant_name": (
        "string",
        "Display name of the Reactome participant",
        "", "false", "Apoptosis signaling",
    ),
    "participant_type": (
        "string",
        "Reactome schema class or internal type of the participant",
        "", "false", "PhysicalEntity",
    ),
    "species": (
        "string",
        "Species associated with the Reactome pathway participant",
        "", "false", "Homo sapiens",
    ),
    "interaction_type": (
        "string",
        "Relationship represented by the row between the pathway and participant",
        "", "false", "participant",
    ),
    "record_id": (
        "string",
        "Stable unique row identifier derived from dataset_id, pathway_id and participant_id",
        "", "false", "rec_ds_reactome_r-hsa-199420_R-HSA-109581",
    ),
    "dataset_id": (
        "string",
        "Foreign key to dataset_catalog.csv identifying the dataset this row belongs to",
        "", "false", "ds_gse178352",
    ),
    "source_id": (
        "string",
        "Foreign key to source_list.csv identifying the originating database",
        "", "false", "src_geo_gse178352",
    ),
    "asset_id": (
        "string",
        "Foreign key to source_assets.csv identifying the downloaded source file",
        "", "false", "asset_a1b2c3d4e5f6",
    ),
    "gene_id_raw": (
        "string",
        "Raw gene identifier as it appears in the source file before normalization",
        "", "false", "ENSG00000000003",
    ),
    "gene_id": (
        "string",
        "Canonical gene identifier after namespace normalization",
        "", "false", "ENSG00000000003",
    ),
    "gene_id_namespace": (
        "string",
        "Namespace/authority for the gene identifier (e.g., ensembl_gene, hgnc_symbol)",
        "", "false", "ensembl_gene",
    ),
    "gene_id_version": (
        "string",
        "Version suffix of the gene identifier when available (e.g., ENSG00000139618.14)",
        "", "true", "ENSG00000139618.14",
    ),
    "sample_id": (
        "string",
        "Foreign key to sample_metadata.csv identifying the sample (GEO GSM accession)",
        "", "false", "GSM8117703",
    ),
    "source_sample_alias": (
        "string",
        "Original sample alias used in the source file's column header",
        "", "false", "A",
    ),
    "measurement_type": (
        "string",
        "Type of measurement (e.g., tximport_estimated_count, sample_metadata)",
        "", "false", "tximport_estimated_count",
    ),
    "value_semantics": (
        "string",
        "Semantic interpretation of the value (e.g., estimated_count, metadata_only)",
        "", "false", "estimated_count",
    ),
    "value_scale": (
        "string",
        "Scale of the value (e.g., linear, log2, na for not-applicable)",
        "", "false", "linear",
    ),
    "is_normalized": (
        "string",
        "Whether the value has been normalized (true/false)",
        "", "false", "false",
    ),
    "is_integer_expected": (
        "string",
        "Whether the value is expected to be an integer (true/false)",
        "", "false", "false",
    ),
    "expression_value": (
        "float",
        "Numeric expression measurement value parsed from the source file",
        "estimated_count", "false", "1.0",
    ),
    "expression_unit": (
        "string",
        "Unit of the expression value (e.g., estimated_count, tpm, fpkm)",
        "", "false", "estimated_count",
    ),
    "source_logical_file": (
        "string",
        "Logical name of the source file within the asset (e.g., GSE178352_tximportCounts.txt)",
        "", "false", "GSE178352_tximportCounts.txt",
    ),
    "source_line_number": (
        "integer",
        "1-based line number in the source file where this value appears",
        "", "false", "2",
    ),
    "source_column_index": (
        "integer",
        "0-based column index in the source file where this value appears",
        "", "false", "1",
    ),
    "source_column_name": (
        "string",
        "Column header name in the source file",
        "", "false", "counts.A",
    ),
    "source_raw_value": (
        "string",
        "Original string value as it appears in the source file before parsing",
        "", "false", "1.0",
    ),
}
