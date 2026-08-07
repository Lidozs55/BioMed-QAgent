"""gene_expression.release.v1 validation profile tests."""

from __future__ import annotations

import csv
from pathlib import Path

from app.datasets.build.profiles import (
    get_validation_profile,
)
from app.datasets.contracts import (
    ArtifactRole,
    DatasetManifest,
    ManifestArtifactEntry,
    ValidationResultStatus,
)
from app.datasets.schema_registry import build_gene_expression_schema

CANONICAL_HEADER = [
    "record_id", "dataset_id", "source_id", "asset_id", "gene_id_raw",
    "gene_id", "gene_id_namespace", "gene_id_version", "sample_id",
    "source_sample_alias", "measurement_type", "value_semantics",
    "value_scale", "is_normalized", "is_integer_expected",
    "expression_value", "expression_unit", "source_logical_file",
    "source_line_number", "source_column_index", "source_column_name",
    "source_raw_value",
]


def _valid_row(gene: str = "TP53", unit: str = "expression_value") -> dict[str, str]:
    return {
        "record_id": f"rec_{gene}",
        "dataset_id": "build_test",
        "source_id": "src_gdc",
        "asset_id": "asset_a" + "0" * 57,
        "gene_id_raw": gene,
        "gene_id": gene,
        "gene_id_namespace": "gene_symbol",
        "gene_id_version": "",
        "sample_id": "S1",
        "source_sample_alias": "S1",
        "measurement_type": "gene_expression",
        "value_semantics": "expression_value",
        "value_scale": "linear",
        "is_normalized": "false",
        "is_integer_expected": "false",
        "expression_value": "1.5",
        "expression_unit": unit,
        "source_logical_file": "gdc_expression.tsv",
        "source_line_number": "2",
        "source_column_index": "1",
        "source_column_name": "S1",
        "source_raw_value": "1.5",
    }


def _write_primary(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CANONICAL_HEADER)
        writer.writeheader()
        writer.writerows(rows)


def _manifest(row_count: int) -> DatasetManifest:
    return DatasetManifest(
        manifest_id="manifest_test",
        task_id="task_test",
        build_id="build_test",
        dataset_family="gene_expression",
        row_granularity="gene_sample_measurement",
        schema_ref="gene_expression.long.v1",
        row_count=row_count,
        sha256="a" * 64,
        artifacts=[
            ManifestArtifactEntry(
                artifact_id="artifact_1",
                role=ArtifactRole.PRIMARY_DATASET,
                relative_path="merged/primary.csv",
                media_type="text/csv",
                size_bytes=1,
                sha256="b" * 64,
            )
        ],
    )


def _validate(tmp_path: Path, rows: list[dict[str, str]], row_count: int | None = None):
    primary = tmp_path / "primary.csv"
    _write_primary(primary, rows)
    manifest = _manifest(row_count if row_count is not None else len(rows))
    profile = get_validation_profile("gene_expression.release.v1")
    return profile.validate(
        manifest=manifest,
        primary_path=primary,
        schema=build_gene_expression_schema(),
        manifest_digest="d" * 64,
        output_dir=tmp_path,
    ), primary


def test_profile_registered() -> None:
    profile = get_validation_profile("gene_expression.release.v1")
    assert profile.profile_id == "gene_expression.release.v1"
    assert profile.profile.acceptance.minimum_valid_rows == 1


def test_valid_primary_passes(tmp_path: Path) -> None:
    result, _ = _validate(tmp_path, [_valid_row()])
    assert result.status is ValidationResultStatus.PASSED
    assert result.failed_count == 0
    assert result.checked_count == 7
    assert (tmp_path / "validation_report.json").is_file()
    assert (tmp_path / "confidence_report.csv").is_file()


def test_empty_primary_fails_min_rows(tmp_path: Path) -> None:
    result, _ = _validate(tmp_path, [], row_count=0)
    assert result.status is ValidationResultStatus.FAILED
    report = (tmp_path / "validation_report.json").read_text()
    assert "minimum_valid_rows" in report


def test_header_only_file_fails_even_when_manifest_claims_rows(tmp_path: Path) -> None:
    """A header-only primary must fail even if the manifest declares rows.

    Regression for the review finding: ``minimum_valid_rows`` used to read the
    manifest-declared row_count, so a truncated/header-only file could
    vacuous-pass (ADR-011: no empty primary may be published as succeeded).
    """
    result, _ = _validate(tmp_path, [], row_count=5)
    assert result.status is ValidationResultStatus.FAILED
    report = (tmp_path / "validation_report.json").read_text()
    assert '"check_id": "minimum_valid_rows"' in report
    assert "file_row_count=0" in report


def test_mixed_units_fail_consistency(tmp_path: Path) -> None:
    rows = [
        _valid_row(gene="TP53", unit="expression_value"),
        _valid_row(gene="BRCA1", unit="tpm_unstranded"),
    ]
    result, _ = _validate(tmp_path, rows)
    assert result.status is ValidationResultStatus.FAILED
    report = (tmp_path / "validation_report.json").read_text()
    assert "unit_consistency" in report


def test_non_numeric_value_fails(tmp_path: Path) -> None:
    row = _valid_row()
    row["expression_value"] = "NaN-value"
    result, _ = _validate(tmp_path, [row])
    assert result.status is ValidationResultStatus.FAILED
    report = (tmp_path / "validation_report.json").read_text()
    assert "expression_value_numeric" in report


def test_nan_and_inf_values_fail(tmp_path: Path) -> None:
    for bad in ("nan", "inf", "-inf"):
        row = _valid_row()
        row["expression_value"] = bad
        result, _ = _validate(tmp_path, [row])
        assert result.status is ValidationResultStatus.FAILED, bad
        assert "expression_value_numeric" in (
            tmp_path / "validation_report.json"
        ).read_text()


def test_missing_provenance_fails_closure(tmp_path: Path) -> None:
    row = _valid_row()
    row["source_logical_file"] = ""
    result, _ = _validate(tmp_path, [row])
    assert result.status is ValidationResultStatus.FAILED
    report = (tmp_path / "validation_report.json").read_text()
    assert "provenance_closure" in report


def test_column_count_mismatch_fails(tmp_path: Path) -> None:
    primary = tmp_path / "primary.csv"
    with primary.open("w", encoding="utf-8", newline="") as handle:
        handle.write("only_one_column\n1\n")
    profile = get_validation_profile("gene_expression.release.v1")
    result = profile.validate(
        manifest=_manifest(1),
        primary_path=primary,
        schema=build_gene_expression_schema(),
        manifest_digest="d" * 64,
        output_dir=tmp_path,
    )
    assert result.status is ValidationResultStatus.FAILED
    report = (tmp_path / "validation_report.json").read_text()
    assert "column_count_matches_schema" in report


def test_missing_primary_file_fails(tmp_path: Path) -> None:
    profile = get_validation_profile("gene_expression.release.v1")
    result = profile.validate(
        manifest=_manifest(1),
        primary_path=tmp_path / "nope.csv",
        schema=build_gene_expression_schema(),
        manifest_digest="d" * 64,
        output_dir=tmp_path,
    )
    assert result.status is ValidationResultStatus.FAILED
    assert "primary_dataset_exists" in (tmp_path / "validation_report.json").read_text()


def test_data_confidence_warning_does_not_block_release(tmp_path: Path) -> None:
    """Statistical anomalies are warnings, never a failed gate (v1, SURVEY §7)."""
    rows = []
    for i in range(60):
        row = _valid_row(gene=f"G{i}")
        row["expression_value"] = "3.7"  # constant column -> anomaly
        rows.append(row)
    result, _ = _validate(tmp_path, rows)
    assert result.status is ValidationResultStatus.PASSED
    assert result.failed_count == 0
    report = (tmp_path / "validation_report.json").read_text()
    assert '"check_id": "data_confidence"' in report
    assert "warnings" in report
    assert "constant_column" in report


def test_data_confidence_report_rows(tmp_path: Path) -> None:
    rows = []
    for i in range(60):
        row = _valid_row(gene=f"G{i}")
        row["expression_value"] = "3.7"
        rows.append(row)
    result, _ = _validate(tmp_path, rows)
    assert result.status is ValidationResultStatus.PASSED
    with (tmp_path / "confidence_report.csv").open(
        "r", encoding="utf-8", newline=""
    ) as handle:
        report_rows = list(csv.DictReader(handle))
    assert report_rows, "confidence report must contain finding rows"
    assert {row["column"] for row in report_rows} == {"expression_value"}
    constant = next(
        row for row in report_rows if row["detector"] == "constant_column"
    )
    assert constant["anomaly"] == "true"
    assert constant["applicable"] == "true"
