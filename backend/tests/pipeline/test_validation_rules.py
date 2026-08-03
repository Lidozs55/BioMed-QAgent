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

_SOURCE_RELATION_COLUMNS = [
    "relation_id", "from_source_id", "to_source_id", "relation_type",
    "evidence_type", "evidence_value", "evidence_url",
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

_CLEANING_REPORT_COLUMNS = [
    "rule", "field_name", "affected_count", "message",
]


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _sha256_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def _build_source_tsv(num_genes: int = 2, num_samples: int = 2) -> bytes:
    """Build a gzipped TSV source file with the given number of genes and samples."""
    header = "gene_id\t" + "\t".join(f"sample{i}" for i in range(1, num_samples + 1))
    lines = [header]
    for g in range(1, num_genes + 1):
        gene_id = f"ENSG{g:03d}"
        values = [str(float(g * 10 + s)) for s in range(1, num_samples + 1)]
        lines.append(gene_id + "\t" + "\t".join(values))
    text = "\n".join(lines) + "\n"
    return gzip.compress(text.encode("utf-8"))


def _build_valid_staging(
    staging: Path,
    source_path: Path,
    source_content: bytes | None = None,
    num_genes: int = 2,
    num_samples: int = 2,
) -> None:
    """Build a complete valid staging package in *staging*.

    The source file is written to *source_path* (outside staging).
    All CSVs are internally consistent so every validation check passes.
    """
    if source_content is None:
        source_content = _build_source_tsv(num_genes, num_samples)
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(source_content)

    staging.mkdir(parents=True, exist_ok=True)

    relative_path = source_path.relative_to(source_path.parents[1]).as_posix()
    size_bytes = len(source_content)
    sha256 = _sha256_bytes(source_content)

    # --- main_data.csv (long form: num_genes * num_samples rows) ---
    main_rows = []
    record_idx = 0
    for g in range(1, num_genes + 1):
        gene_id = f"ENSG{g:03d}"
        source_line = g + 1  # 1-based, header is line 1
        for s in range(1, num_samples + 1):
            sample_id = f"GSM{s:03d}"
            sample_alias = f"sample{s}"
            source_col = s  # 0-based, gene_id is column 0
            value = str(float(g * 10 + s))
            record_idx += 1
            main_rows.append({
                "record_id": f"r{record_idx}",
                "dataset_id": "ds1", "source_id": "src_geo",
                "asset_id": "asset_1", "gene_id_raw": gene_id, "gene_id": gene_id,
                "gene_id_namespace": "Ensembl", "gene_id_version": "",
                "sample_id": sample_id, "source_sample_alias": sample_alias,
                "measurement_type": "count", "value_semantics": "float",
                "value_scale": "raw", "is_normalized": "false",
                "is_integer_expected": "false", "expression_value": value,
                "expression_unit": "count", "source_logical_file": "source.tsv",
                "source_line_number": str(source_line),
                "source_column_index": str(source_col),
                "source_column_name": sample_alias, "source_raw_value": value,
            })
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, main_rows)

    # --- dataset_catalog.csv ---
    _write_csv(staging / "dataset_catalog.csv", _DATASET_CATALOG_COLUMNS, [
        {"dataset_id": "ds1", "source_id": "src_geo", "database": "geo",
         "accession": "GSE999999", "title": "Test", "organism": "Homo sapiens",
         "experiment_type": "RNA-Seq", "sample_count": str(num_samples),
         "platform_ids": "[]", "related_pmids": "[]",
         "source_url": "https://example.test", "retrieved_at": "2026-01-01T00:00:00"},
    ])

    # --- sample_metadata.csv ---
    sample_rows = []
    for s in range(1, num_samples + 1):
        sample_rows.append({
            "sample_id": f"GSM{s:03d}", "dataset_id": "ds1", "source_id": "src_geo",
            "source_sample_alias": f"sample{s}", "cell_line_raw": "",
            "cell_line_canonical": "", "normalization_rule": "",
            "treatment": "", "replicate": "", "organism": "Homo sapiens",
            "source_url": "https://example.test",
        })
    _write_csv(staging / "sample_metadata.csv", _SAMPLE_METADATA_COLUMNS, sample_rows)

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

    # --- cleaning_report.csv (present with no anomalies by default) ---
    _write_csv(staging / "cleaning_report.csv", _CLEANING_REPORT_COLUMNS, [])


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


def test_source_relation_validation_rejects_unclosed_or_false_evidence(
    tmp_path: Path,
) -> None:
    task_root = tmp_path / "tasks" / "bad_relation"
    staging = task_root / "staging"
    source_path = task_root / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)
    _write_csv(
        staging / "source_relations.csv",
        _SOURCE_RELATION_COLUMNS,
        [
            {
                "relation_id": "rel_false",
                "from_source_id": "src_missing_pubmed",
                "to_source_id": "src_geo",
                "relation_type": "article_describes_dataset",
                "evidence_type": "geo_pubmed_id",
                "evidence_value": "99999999",
                "evidence_url": "https://hostile.example/fabricated",
            }
        ],
    )

    summary, checks = _run_validation(staging, source_path, task_root)

    relation_check = _check_by_id(checks, "source_relation_evidence")
    assert summary.status == "invalid"
    assert relation_check["status"] == "failed"
    assert relation_check["failed_count"] == 1


# ---------------------------------------------------------------------------
# Rule 1: foreign_keys — main_data dataset/sample/source/asset must exist
# ---------------------------------------------------------------------------


def test_main_data_nonempty_rejects_header_only_artifact(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, [])

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")

    assert summary.status == "invalid"
    nonempty = _check_by_id(checks, "main_data_nonempty")
    assert nonempty["status"] == "failed"
    assert nonempty["checked_count"] == 0
    assert nonempty["failed_count"] == 1


def test_core_scientific_values_rejects_metadata_only_main_data(
    tmp_path: Path,
) -> None:
    task_root = tmp_path / "tasks" / "metadata_only"
    staging = task_root / "staging"
    source_path = task_root / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    with (staging / "main_data.csv").open(
        "r", encoding="utf-8", newline=""
    ) as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        row.update(
            {
                "gene_id_raw": "",
                "gene_id": "",
                "gene_id_namespace": "",
                "measurement_type": "sample_metadata",
                "value_semantics": "metadata_only",
                "expression_value": "",
                "expression_unit": "na",
                "source_line_number": "0",
                "source_column_index": "0",
                "source_raw_value": "",
            }
        )
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    summary, checks = _run_validation(staging, source_path, task_root)
    by_id = {check["check_id"]: check for check in checks}

    assert "core_scientific_values" in by_id
    assert by_id["core_scientific_values"]["status"] == "failed"
    assert summary.status == "invalid"


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


def test_foreign_keys_rejects_mixed_but_individually_valid_lineage(
    tmp_path: Path,
) -> None:
    """A row's valid IDs must still belong to one provenance chain."""
    task_root = tmp_path / "tasks" / "task_mixed_lineage"
    staging = task_root / "staging"
    source_path = task_root / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    source_rows = _read_csv(staging / "source_list.csv")
    source_rows.append(
        {
            "source_id": "src_other",
            "database": "geo",
            "accession": "GSE111111",
            "url": "https://example.test/other",
            "title": "Other valid source",
            "retrieved_at": "2026-01-01T00:00:00",
        }
    )
    _write_csv(staging / "source_list.csv", _SOURCE_LIST_COLUMNS, source_rows)
    main_rows = _read_csv(staging / "main_data.csv")
    main_rows[0]["source_id"] = "src_other"
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, main_rows)

    summary, checks = _run_validation(staging, source_path, task_root)

    assert summary.status == "invalid"
    foreign_keys = _check_by_id(checks, "foreign_keys")
    assert foreign_keys["status"] == "failed"
    assert foreign_keys["failed_count"] == 1


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


def test_warnings_consistency_passes_when_non_empty_and_matched(tmp_path: Path) -> None:
    """Non-empty warnings that match processing_log warnings count should pass."""
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)

    # Add 2 warning rows to warnings.csv
    _write_csv(staging / "warnings.csv", _WARNINGS_COLUMNS, [
        {"warning_id": "w1", "severity": "low", "stage": "processing",
         "code": "non_numeric_value", "message": "test warning 1",
         "source_id": "src_geo", "asset_id": "asset_1",
         "record_id": "r1", "created_at": "2026-01-01T00:00:00"},
        {"warning_id": "w2", "severity": "medium", "stage": "processing",
         "code": "duplicate_gene", "message": "test warning 2",
         "source_id": "src_geo", "asset_id": "asset_1",
         "record_id": "r2", "created_at": "2026-01-01T00:00:00"},
    ])

    # Update processing_log.csv warnings field to contain 2 matching warning objects
    proc_rows = _read_csv(staging / "processing_log.csv")
    proc_rows[0]["warnings"] = json.dumps([
        {"code": "non_numeric_value", "message": "test warning 1"},
        {"code": "duplicate_gene", "message": "test warning 2"},
    ])
    _write_csv(staging / "processing_log.csv", _PROCESSING_LOG_COLUMNS, proc_rows)

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")
    wc = _check_by_id(checks, "warnings_metrics_consistency")
    assert wc["status"] == "passed"
    assert wc["failed_count"] == 0


def test_cleaning_report_consistency_rejects_missing_report(tmp_path: Path) -> None:
    staging = tmp_path / "tasks" / "task1" / "staging"
    source_path = tmp_path / "tasks" / "task1" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)
    (staging / "cleaning_report.csv").unlink()

    summary, checks = _run_validation(staging, source_path, tmp_path / "tasks" / "task1")

    assert summary.status == "invalid"
    cleaning = _check_by_id(checks, "cleaning_report_consistency")
    assert cleaning["status"] == "failed"
    assert cleaning["failed_count"] == 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


# ---------------------------------------------------------------------------
# Rule 7 (NEW): deterministic sampling of source_value_lineage
# Default 100 samples; small datasets checked fully; sampling is deterministic.
# ---------------------------------------------------------------------------


def test_lineage_sampling_when_rows_exceed_max(tmp_path: Path) -> None:
    """When main_data has more rows than max_lineage_checks, only a sample is checked."""
    import app.pipeline.stages.validation as validation_module

    staging = tmp_path / "tasks" / "task_big" / "staging"
    source_path = tmp_path / "tasks" / "task_big" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path, num_genes=30, num_samples=10)

    max_checks = 5
    summary, checks = validation_module._validate_package(
        staging, source_path, tmp_path / "tasks" / "task_big" / "logs" / "r.json",
        max_lineage_checks=max_checks,
    )
    svl = _check_by_id(checks, "source_value_lineage")
    assert int(svl["checked_count"]) == max_checks
    details = json.loads(svl["details"])
    assert details["total_rows"] > max_checks
    assert details["sampled"] == max_checks
    assert svl["status"] == "passed"


def test_lineage_full_when_rows_under_max(tmp_path: Path) -> None:
    """When main_data has fewer rows than max_lineage_checks, all rows are checked."""
    import app.pipeline.stages.validation as validation_module

    staging = tmp_path / "tasks" / "task_small" / "staging"
    source_path = tmp_path / "tasks" / "task_small" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path)  # default 2 genes x 2 samples = 4 rows

    max_checks = 100
    summary, checks = validation_module._validate_package(
        staging, source_path, tmp_path / "tasks" / "task_small" / "logs" / "r.json",
        max_lineage_checks=max_checks,
    )
    svl = _check_by_id(checks, "source_value_lineage")
    rows = _read_csv(staging / "main_data.csv")
    assert int(svl["checked_count"]) == len(rows)
    details = json.loads(svl["details"])
    assert details["total_rows"] == len(rows)
    assert details["sampled"] == len(rows)


def test_lineage_unlimited_checks_row_omitted_by_default_sample(
    tmp_path: Path,
) -> None:
    """Unlimited validation must catch corruption outside the default sample."""
    import app.pipeline.stages.validation as validation_module

    staging = tmp_path / "tasks" / "task_unlimited" / "staging"
    source_path = (
        tmp_path / "tasks" / "task_unlimited" / "source_assets" / "source.tsv.gz"
    )
    _build_valid_staging(staging, source_path, num_genes=101, num_samples=1)

    rows = _read_csv(staging / "main_data.csv")
    sampled_ids = {
        row["record_id"]
        for row in validation_module._deterministic_sample(rows, 100)
    }
    omitted = next(row for row in rows if row["record_id"] not in sampled_ids)
    omitted["expression_value"] = "999999.0"
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    sampled_summary, _ = validation_module._validate_package(
        staging,
        source_path,
        tmp_path / "tasks" / "task_unlimited" / "logs" / "sampled.json",
    )
    full_summary, full_checks = validation_module._validate_package(
        staging,
        source_path,
        tmp_path / "tasks" / "task_unlimited" / "logs" / "full.json",
        max_lineage_checks=None,
    )

    assert sampled_summary.status == "valid"
    assert full_summary.status == "invalid"
    lineage = _check_by_id(full_checks, "source_value_lineage")
    assert lineage["checked_count"] == len(rows)
    assert lineage["failed_count"] == 1


def test_only_canonical_pinned_specification_requires_full_lineage() -> None:
    """The official acceptance pair gets full checks; lookalikes stay sampled."""
    import app.pipeline.stages.validation as validation_module
    from app.domain.contracts import (
        Database,
        DatasetSelection,
        QuerySpecification,
        TaskSpecification,
    )

    def specification(pmid: str) -> TaskSpecification:
        return TaskSpecification(
            topic="pinned acceptance",
            queries=[
                QuerySpecification(
                    query_id="q_pubmed",
                    database=Database.PUBMED,
                    query=f"{pmid}[PMID]",
                    generated_by="pipeline",
                    purpose="acceptance literature",
                    order=1,
                )
            ],
            datasets=[
                DatasetSelection(
                    dataset_id="ds_geo_gse178352",
                    database=Database.GEO,
                    accession="gse178352",
                    reason="acceptance dataset",
                )
            ],
        )

    assert validation_module._requires_full_lineage_validation(
        specification("34180400")
    )
    assert not validation_module._requires_full_lineage_validation(
        specification("99999999")
    )


def test_lineage_sampling_is_deterministic(tmp_path: Path) -> None:
    """Same input produces the same sampled rows every run."""
    import app.pipeline.stages.validation as validation_module

    staging = tmp_path / "tasks" / "task_det" / "staging"
    source_path = tmp_path / "tasks" / "task_det" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path, num_genes=20, num_samples=10)

    max_checks = 8
    _s1, checks1 = validation_module._validate_package(
        staging, source_path, tmp_path / "tasks" / "task_det" / "logs" / "r1.json",
        max_lineage_checks=max_checks,
    )
    _s2, checks2 = validation_module._validate_package(
        staging, source_path, tmp_path / "tasks" / "task_det" / "logs" / "r2.json",
        max_lineage_checks=max_checks,
    )
    svl1 = _check_by_id(checks1, "source_value_lineage")
    svl2 = _check_by_id(checks2, "source_value_lineage")
    assert svl1["checked_count"] == svl2["checked_count"]
    assert svl1["details"] == svl2["details"]
    assert svl1["failed_count"] == svl2["failed_count"]


def test_sampling_detects_failure_in_sampled_row(tmp_path: Path) -> None:
    """A corrupted value that falls in the sampled set is still detected."""
    import app.pipeline.stages.validation as validation_module

    staging = tmp_path / "tasks" / "task_fail" / "staging"
    source_path = tmp_path / "tasks" / "task_fail" / "source_assets" / "source.tsv.gz"
    _build_valid_staging(staging, source_path, num_genes=50, num_samples=10)

    rows = _read_csv(staging / "main_data.csv")
    # Corrupt several rows — with 500 rows and sample size 50, at least
    # one corrupted row should land in the sample with overwhelming probability.
    for i in range(0, len(rows), 10):
        rows[i]["expression_value"] = "999999.0"
    _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, rows)

    summary, checks = validation_module._validate_package(
        staging, source_path, tmp_path / "tasks" / "task_fail" / "logs" / "r.json",
        max_lineage_checks=50,
    )
    svl = _check_by_id(checks, "source_value_lineage")
    assert svl["status"] == "failed"
    assert int(svl["failed_count"]) >= 1
