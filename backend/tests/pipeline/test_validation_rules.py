"""Per-rule negative tests for the validation gate.

Each test builds a minimal valid staging package, corrupts exactly one
CSV or source file, then asserts the corresponding validation check
reports ``status="failed"`` with the expected ``failed_count``.

These tests complement ``test_pipeline_e2e.py`` Scenario 6 (which only
tests the soft-failure path via monkeypatch) by exercising the actual
validation logic in ``_validate_package``.
"""
from __future__ import annotations

import csv
import gzip
import json
from pathlib import Path

from app.pipeline.stages.validation import _validate_package

# ---------------------------------------------------------------------------
# Minimal valid staging package builder
# ---------------------------------------------------------------------------

_MAIN_DATA_COLUMNS = [
    "record_id", "dataset_id", "source_id", "asset_id", "gene_id_raw",
    "gene_id", "gene_id_namespace", "gene_id_version", "sample_id",
    "source_sample_alias", "measurement_type", "value_semantics",
    "value_scale", "is_normalized", "is_integer_expected",
    "expression_value", "expression_unit", "source_logical_file",
    "source_line_number", "source_column_index", "source_column_name",
    "source_raw_value",
]

_FIELD_DESCRIPTION_COLUMNS = [
    "field_name", "data_type", "description", "unit", "nullable",
    "source", "example",
]

_DATASET_CATALOG_COLUMNS = [
    "dataset_id", "source_id", "database", "accession", "title",
    "organism", "experiment_type", "sample_count", "platform_ids",
    "related_pmids", "source_url", "retrieved_at",
]

_SAMPLE_METADATA_COLUMNS = [
    "sample_id", "dataset_id", "source_id", "source_sample_alias",
    "cell_line_raw", "cell_line_canonical", "normalization_rule",
    "treatment", "replicate", "organism", "source_url",
]

_SOURCE_LIST_COLUMNS = [
    "source_id", "database", "accession", "url", "title", "retrieved_at",
]

_SOURCE_ASSET_COLUMNS = [
    "asset_id", "source_id", "successful_attempt_id", "data_level",
    "relative_path", "size_bytes", "sha256", "media_type", "schema_version",
]

_DOWNLOAD_LOG_COLUMNS = [
    "attempt_id", "source_id", "url", "status", "bytes_received",
    "error_code", "error_message", "started_at", "finished_at",
]

_PROCESSING_LOG_COLUMNS = [
    "step_id", "stage_attempt_id", "stage", "operation", "input_refs",
    "output_refs", "tool_version", "rows_before", "rows_after",
    "parameters", "status", "started_at", "finished_at", "warnings",
]

_WARNINGS_COLUMNS = [
    "warning_id", "severity", "stage", "code", "message",
    "source_id", "asset_id", "record_id", "created_at",
]


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _sha256_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def _build_source_tsv() -> bytes:
    """Build a minimal gzipped TSV source file with 2 genes × 2 samples."""
    lines = [
        "gene_id\tsample1\tsample2",
        "ENSG001\t10.0\t20.0",
        "ENSG002\t30.0\t40.0",
    ]
    text = "\n".join(lines) + "\n"
    return gzip.compress(text.encode("utf-8"))


def _build_valid_staging(
    staging: Path,
    source_path: Path,
    source_content: bytes | None = None,
) -> None:
    """Build a complete valid staging package in *staging*.

    The source file is written to *source_path* (outside staging).
    All CSVs are internally consistent so every validation check passes.
    """
    if source_content is None:
        source_content = _build_source_tsv()
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(source_content)

    staging.mkdir(parents=True, exist_ok=True)

    relative_path = source_path.relative_to(source_path.parents[1]).as_posix()
    size_bytes = len(source_content)
    sha256 = _sha256_bytes(source_content)

    # --- main_data.csv (long form: 4 rows = 2 genes × 2 samples) ---
    main_rows = [
        {"record_id": "r1", "dataset_id": "ds1", "source_id": "src_geo",
         "asset_id": "asset_1", "gene_id_raw": "ENSG001", "gene_id": "ENSG001",
         "gene_id_namespace": "Ensembl", "gene_id_version": "",
         "sample_id": "GSM001", "source_sample_alias": "sample1",
         "measurement_type": "count", "value_semantics": "float",
         "value_scale": "raw", "is_normalized": "false",
         "is_integer_expected": "false", "expression_value": "10.0",
         "expression_unit": "count", "source_logical_file": "source.tsv",
         "source_line_number": "2", "source_column_index": "1",
         "source_column_name": "sample1", "source_raw_value": "10.0"},
        {"record_id": "r2", "dataset_id": "ds1", "source_id": "src_geo",
         "asset_id": "asset_1", "gene_id_raw": "ENSG002", "gene_id": "ENSG002",
         "gene_id_namespace": "Ensembl", "gene_id_version": "",
         "sample_id": "GSM001", "source_sample_alias": "sample1",
         "measurement_type": "count", "value_semantics": "float",
         "value_scale": "raw", "is_normalized": "false",
         "is_integer_expected": "false", "expression_value": "30.0",
         "expression_unit": "count", "source_logical_file": "source.tsv",
         "source_line_number": "3", "source_column_index": "1",
         "source_column_name": "sample1", "source_raw_value": "30.0"},
        {"record_id": "r3", "dataset_id": "ds1", "source_id": "src_geo",
         "asset_id": "asset_1", "gene_id_raw": "ENSG001", "gene_id": "ENSG001",
         "gene_id_namespace": "Ensembl", "gene_id_version": "",
         "sample_id": "GSM002", "source_sample_alias": "sample2",
         "measurement_type": "count", "value_semantics": "float",
         "value_scale": "raw", "is_normalized": "false",
         "is_integer_expected": "false", "expression_value": "20.0",
         "expression_unit": "count", "source_logical_file": "source.tsv",
         "source_line_number": "2", "source_column_index": "2",
         "source_column_name": "sample2", "source_raw_value": "20.0"},
        {"record_id": "r4", "dataset_id": "ds1", "source_id": "src_geo",
         "asset_id": "asset_1", "gene_id_raw": "ENSG002", "gene_id": "ENSG002",
         "gene_id_namespace": "Ensembl", "gene_id_version": "",
         "sample_id": "GSM002", "source_sample_alias": "sample2",
         "measurement_type": "count", "value_semantics": "float",
         "value_scale": "raw", "is_normalized": "false",
         "is_integer_expected": "false", "expression_value": "40.0",
         "expression_unit": "count", "source_logical_file": "source.tsv",
         "source_line_number": "3", "source_column_index": "2",
         "source_column_name": "sample2", "source_raw_value": "40.0"},
    ]
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, main_rows)

    # --- dataset_catalog.csv ---
    _write_csv(staging / "dataset_catalog.csv", _DATASET_CATALOG_COLUMNS, [
        {"dataset_id": "ds1", "source_id": "src_geo", "database": "geo",
         "accession": "GSE999999", "title": "Test", "organism": "Homo sapiens",
         "experiment_type": "RNA-Seq", "sample_count": 2,
         "platform_ids": "[]", "related_pmids": "[]",
         "source_url": "https://example.test", "retrieved_at": "2026-01-01T00:00:00"},
    ])

    # --- sample_metadata.csv ---
    _write_csv(staging / "sample_metadata.csv", _SAMPLE_METADATA_COLUMNS, [
        {"sample_id": "GSM001", "dataset_id": "ds1", "source_id": "src_geo",
         "source_sample_alias": "sample1", "cell_line_raw": "",
         "cell_line_canonical": "", "normalization_rule": "",
         "treatment": "", "replicate": "", "organism": "Homo sapiens",
         "source_url": "https://example.test"},
        {"sample_id": "GSM002", "dataset_id": "ds1", "source_id": "src_geo",
         "source_sample_alias": "sample2", "cell_line_raw": "",
         "cell_line_canonical": "", "normalization_rule": "",
         "treatment": "", "replicate": "", "organism": "Homo sapiens",
         "source_url": "https://example.test"},
    ])

    # --- source_list.csv ---
    _write_csv(staging / "source_list.csv", _SOURCE_LIST_COLUMNS, [
        {"source_id": "src_geo", "database": "geo", "accession": "GSE999999",
         "url": "https://example.test", "title": "Test",
         "retrieved_at": "2026-01-01T00:00:00"},
    ])

    # --- source_assets.csv ---
    _write_csv(staging / "source_assets.csv", _SOURCE_ASSET_COLUMNS, [
        {"asset_id": "asset_1", "source_id": "src_geo",
         "successful_attempt_id": "attempt_1", "data_level": "repository_processed",
         "relative_path": relative_path, "size_bytes": size_bytes,
         "sha256": sha256, "media_type": "application/gzip",
         "schema_version": "1.0"},
    ])

    # --- download_log.csv ---
    _write_csv(staging / "download_log.csv", _DOWNLOAD_LOG_COLUMNS, [
        {"attempt_id": "attempt_1", "source_id": "src_geo",
         "url": "https://example.test/file.gz", "status": "succeeded",
         "bytes_received": size_bytes, "error_code": "",
         "error_message": "", "started_at": "2026-01-01T00:00:00",
         "finished_at": "2026-01-01T00:00:01"},
    ])

    # --- field_descriptions.csv (covers all main_data columns) ---
    _write_csv(staging / "field_descriptions.csv", _FIELD_DESCRIPTION_COLUMNS, [
        {"field_name": col, "data_type": "string", "description": col,
         "unit": "", "nullable": "false", "source": "test", "example": ""}
        for col in _MAIN_DATA_COLUMNS
    ])

    # --- processing_log.csv (no warnings by default) ---
    _write_csv(staging / "processing_log.csv", _PROCESSING_LOG_COLUMNS, [
        {"step_id": "step_test_v1", "stage_attempt_id": "attempt_test",
         "stage": "processing", "operation": "parse_counts",
         "input_refs": "[]", "output_refs": "[]", "tool_version": "1.0.0",
         "rows_before": 4, "rows_after": 4,
         "parameters": "{}", "status": "succeeded",
         "started_at": "2026-01-01T00:00:00",
         "finished_at": "2026-01-01T00:00:01",
         "warnings": "[]"},
    ])

    # --- warnings.csv (empty by default) ---
    _write_csv(staging / "warnings.csv", _WARNINGS_COLUMNS, [])


def _run_validation(staging: Path, source_path: Path, tmp_path: Path):
    """Call _validate_package and return (summary, checks)."""
    report_path = tmp_path / "logs" / "validation_report.json"
    return _validate_package(staging, source_path, report_path)


def _check_by_id(checks: list[dict], check_id: str) -> dict:
    return next(c for c in checks if c["check_id"] == check_id)


# ---------------------------------------------------------------------------
# Baseline: valid package passes all checks
# ---------------------------------------------------------------------------


def test_valid_package_passes_all_checks(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")

    assert summary.status == "valid"
    assert summary.failed_count == 0
    for check in checks:
        assert check["status"] == "passed", f"{check['check_id']} unexpectedly failed"


# ---------------------------------------------------------------------------
# Rule 1: foreign_keys — main_data dataset/sample/source/asset must exist
# ---------------------------------------------------------------------------


def test_foreign_keys_detects_unknown_dataset_id(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "main_data.csv")
    rows[0]["dataset_id"] = "nonexistent_ds"
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    assert summary.status == "invalid"
    fk = _check_by_id(checks, "foreign_keys")
    assert fk["status"] == "failed"
    assert fk["failed_count"] == 1


def test_foreign_keys_detects_unknown_sample_id(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "main_data.csv")
    rows[0]["sample_id"] = "GSM_NONEXIST"
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    assert summary.status == "invalid"
    fk = _check_by_id(checks, "foreign_keys")
    assert fk["status"] == "failed"
    assert fk["failed_count"] == 1


def test_foreign_keys_detects_unknown_source_id(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "main_data.csv")
    rows[1]["source_id"] = "src_nonexist"
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    fk = _check_by_id(checks, "foreign_keys")
    assert fk["status"] == "failed"
    assert fk["failed_count"] == 1


def test_foreign_keys_detects_unknown_asset_id(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "main_data.csv")
    rows[2]["asset_id"] = "asset_nonexist"
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    fk = _check_by_id(checks, "foreign_keys")
    assert fk["status"] == "failed"
    assert fk["failed_count"] == 1


# ---------------------------------------------------------------------------
# Rule 2: sample_foreign_keys — sample_metadata dataset/source must exist
# ---------------------------------------------------------------------------


def test_sample_foreign_keys_detects_unknown_dataset(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "sample_metadata.csv")
    rows[0]["dataset_id"] = "ds_nonexist"
    _write_csv(staging / "sample_metadata.csv", _SAMPLE_METADATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    sfk = _check_by_id(checks, "sample_foreign_keys")
    assert sfk["status"] == "failed"
    assert sfk["failed_count"] == 1


def test_sample_foreign_keys_detects_unknown_source(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "sample_metadata.csv")
    rows[1]["source_id"] = "src_nonexist"
    _write_csv(staging / "sample_metadata.csv", _SAMPLE_METADATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    sfk = _check_by_id(checks, "sample_foreign_keys")
    assert sfk["status"] == "failed"
    assert sfk["failed_count"] == 1


# ---------------------------------------------------------------------------
# Rule 3: source_asset_integrity — checksum, size, path, attempt
# ---------------------------------------------------------------------------


def test_source_asset_integrity_detects_checksum_mismatch(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "source_assets.csv")
    rows[0]["sha256"] = "0" * 64
    _write_csv(staging / "source_assets.csv", _SOURCE_ASSET_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    sai = _check_by_id(checks, "source_asset_integrity")
    assert sai["status"] == "failed"
    assert sai["failed_count"] == 1


def test_source_asset_integrity_detects_size_mismatch(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "source_assets.csv")
    rows[0]["size_bytes"] = "999999"
    _write_csv(staging / "source_assets.csv", _SOURCE_ASSET_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    sai = _check_by_id(checks, "source_asset_integrity")
    assert sai["status"] == "failed"


def test_source_asset_integrity_detects_bad_attempt_id(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "source_assets.csv")
    rows[0]["successful_attempt_id"] = "attempt_nonexist"
    _write_csv(staging / "source_assets.csv", _SOURCE_ASSET_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    sai = _check_by_id(checks, "source_asset_integrity")
    assert sai["status"] == "failed"


def test_source_asset_integrity_detects_wrong_relative_path(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "source_assets.csv")
    rows[0]["relative_path"] = "wrong/path.tsv.gz"
    _write_csv(staging / "source_assets.csv", _SOURCE_ASSET_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    sai = _check_by_id(checks, "source_asset_integrity")
    assert sai["status"] == "failed"


# ---------------------------------------------------------------------------
# Rule 4: field_descriptions — every main_data column must be described
# ---------------------------------------------------------------------------


def test_field_descriptions_detects_missing_field(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "field_descriptions.csv")
    # Remove the description for "expression_value"
    rows = [r for r in rows if r["field_name"] != "expression_value"]
    _write_csv(staging / "field_descriptions.csv", _FIELD_DESCRIPTION_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    fd = _check_by_id(checks, "field_descriptions")
    assert fd["status"] == "failed"
    assert fd["failed_count"] == 1
    missing = json.loads(fd["details"])
    assert "expression_value" in missing


# ---------------------------------------------------------------------------
# Rule 5: source_value_lineage — raw value must match source file
# ---------------------------------------------------------------------------


def test_source_value_lineage_detects_wrong_raw_value(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "main_data.csv")
    rows[0]["source_raw_value"] = "999.0"
    rows[0]["expression_value"] = "999.0"
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    svl = _check_by_id(checks, "source_value_lineage")
    assert svl["status"] == "failed"
    assert svl["failed_count"] == 1


def test_source_value_lineage_detects_value_mismatch(tmp_path: Path) -> None:
    """raw_value matches source but expression_value doesn't match raw."""
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "main_data.csv")
    # Keep source_raw_value = "10.0" (matches source), but corrupt expression_value
    rows[0]["expression_value"] = "999.0"
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    svl = _check_by_id(checks, "source_value_lineage")
    assert svl["status"] == "failed"
    assert svl["failed_count"] == 1


def test_source_value_lineage_detects_out_of_range_line(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    rows = _read_csv(staging / "main_data.csv")
    rows[0]["source_line_number"] = "999"  # out of range
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    svl = _check_by_id(checks, "source_value_lineage")
    assert svl["status"] == "failed"
    assert svl["failed_count"] == 1


# ---------------------------------------------------------------------------
# Rule 6 (NEW): warnings_metrics_consistency
# Non-empty warnings.csv must agree with processing_log warnings count.
# ---------------------------------------------------------------------------


def test_warnings_consistency_detects_unlogged_warning(tmp_path: Path) -> None:
    """warnings.csv has a row but processing_log warnings field is empty list."""
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    # Add a warning row
    _write_csv(staging / "warnings.csv", _WARNINGS_COLUMNS, [
        {"warning_id": "w1", "severity": "low", "stage": "processing",
         "code": "non_numeric_value", "message": "test warning",
         "source_id": "src_geo", "asset_id": "asset_1",
         "record_id": "r1", "created_at": "2026-01-01T00:00:00"},
    ])

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    assert summary.status == "invalid"
    wc = _check_by_id(checks, "warnings_metrics_consistency")
    assert wc["status"] == "failed"
    assert wc["failed_count"] >= 1


def test_warnings_consistency_passes_when_empty(tmp_path: Path) -> None:
    """No warnings — consistency check should pass."""
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    wc = _check_by_id(checks, "warnings_metrics_consistency")
    assert wc["status"] == "passed"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))
