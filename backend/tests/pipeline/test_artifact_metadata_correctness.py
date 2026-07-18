"""Per-artifact metadata correctness tests for TODO §1.7 + §1.2.

Locks in the post-fix invariants for the artifact package:

* Every CSV artifact (14 staging files + quality_report.csv) starts with a
  UTF-8 BOM so Excel opens Chinese/UTF-8 content without garbling.
* ``run_manifest.json`` records the actual Qwen model name (not ``None``).
* ``warnings.csv`` records cell-line canonicalization corrections and its
  row count matches the ``warnings`` JSON array in ``processing_log.csv``
  (the ``warnings_metrics_consistency`` validation check).
* ``field_descriptions.csv`` carries real semantic descriptions, data types,
  units, and example values — not placeholders like ``field.replace("_", " ")``.
* ``_write_csv`` rejects rows with fields not in the column list instead of
  silently dropping them (``extrasaction="ignore"`` is forbidden).

These tests complement ``test_pinned_pipeline.py`` (which only asserts the
happy-path artifact set) by pinning the metadata correctness invariants
identified in the second-round review (TODO §1.7 + §1.2).
"""
from __future__ import annotations

import asyncio
import contextlib
import csv
import json
from pathlib import Path

import pytest
from app.config import settings
from app.pipeline.runner import PipelineRunner
from app.pipeline.stages.artifact_build import _write_csv as _write_csv_artifact
from app.pipeline.stages.validation import _write_csv as _write_csv_validation

FIXTURE_DIR = (
    Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
)

# All CSV artifacts that must carry a UTF-8 BOM for Excel compatibility.
_BOM_REQUIRED_CSV_NAMES = {
    "main_data.csv",
    "literature.csv",
    "dataset_catalog.csv",
    "sample_metadata.csv",
    "field_descriptions.csv",
    "field_mapping.csv",
    "source_list.csv",
    "source_relations.csv",
    "source_assets.csv",
    "download_log.csv",
    "processing_log.csv",
    "warnings.csv",
    "quality_report.csv",
}

# Fields in main_data.csv that must have real semantic descriptions.
_REQUIRED_FIELD_DESCRIPTIONS = {
    "record_id",
    "dataset_id",
    "source_id",
    "asset_id",
    "gene_id",
    "gene_id_namespace",
    "sample_id",
    "expression_value",
    "source_line_number",
    "source_column_index",
    "source_raw_value",
    "source_logical_file",
}


def _read_csv_sig(path: Path) -> list[dict[str, str]]:
    """Read a CSV with ``utf-8-sig`` so the BOM is stripped from the first header."""
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _run_pinned_pipeline(tmp_path: Path) -> Path:
    """Run the GSE178352 pinned fixture pipeline and return the artifacts dir."""
    runner = PipelineRunner(
        task_id="task_metadata_correctness",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "completed", (
        f"pinned pipeline must complete successfully; got {manifest.task_state}"
    )
    return tmp_path / "tasks" / "task_metadata_correctness" / "artifacts"


# ---------------------------------------------------------------------------
# §1.7 CSV UTF-8 BOM
# ---------------------------------------------------------------------------


def test_all_artifact_csvs_have_utf8_bom(tmp_path: Path) -> None:
    """Every CSV artifact must start with ``\\xef\\xbb\\xbf`` (UTF-8 BOM).

    Without BOM, Excel on Windows opens UTF-8 CSVs with garbled Chinese
    characters — a direct scoring penalty for the competition's "结构化输出
    样例" criterion.
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    produced_csvs = {
        path.name for path in artifacts.iterdir() if path.suffix == ".csv"
    }
    missing = _BOM_REQUIRED_CSV_NAMES - produced_csvs
    assert not missing, f"expected CSV artifacts missing: {missing}"

    for name in _BOM_REQUIRED_CSV_NAMES:
        path = artifacts / name
        first_bytes = path.read_bytes()[:3]
        assert first_bytes == b"\xef\xbb\xbf", (
            f"{name} must start with UTF-8 BOM (\\xef\\xbb\\xbf); "
            f"got {first_bytes!r}"
        )


# ---------------------------------------------------------------------------
# §1.7 run_manifest.json model_name
# ---------------------------------------------------------------------------


def test_run_manifest_model_name_not_none(tmp_path: Path) -> None:
    """``run_manifest.json`` must record the actual Qwen model name.

    ``model_name=None`` breaks reproducibility — judges cannot tell which
    model produced the artifacts. The manifest must read
    ``settings.model_name`` (default ``qwen-plus``).
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    manifest_json = json.loads((artifacts / "run_manifest.json").read_text("utf-8"))
    assert manifest_json["model_name"] is not None, (
        "run_manifest.json model_name must not be None"
    )
    assert manifest_json["model_name"] == settings.model_name, (
        f"run_manifest.json model_name must equal settings.model_name "
        f"({settings.model_name!r}); got {manifest_json['model_name']!r}"
    )


# ---------------------------------------------------------------------------
# §1.7 warnings.csv cell-line corrections
# ---------------------------------------------------------------------------


def test_warnings_csv_records_cell_line_corrections(tmp_path: Path) -> None:
    """``warnings.csv`` must record MD-MBA-231 → MDA-MB-231 corrections.

    The GSE178352 fixture ships samples with ``cell_line_raw="MD-MBA-231"``
    that are canonicalized to ``"MDA-MB-231"`` in
    ``geo_tximport._CELL_LINE_CANONICAL``. Each correction must produce one
    ``warnings.csv`` row with ``code="cell_line_normalized"`` so judges can
    audit the normalization.

    The row count must also match the ``warnings`` JSON array in
    ``processing_log.csv`` (the ``warnings_metrics_consistency`` check).
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    warning_rows = _read_csv_sig(artifacts / "warnings.csv")
    cell_line_warnings = [
        row for row in warning_rows if row["code"] == "cell_line_normalized"
    ]
    # GSE178352 fixture has 3 samples with MD-MBA-231 and 3 with MD-MBA-453
    # (see _CELL_LINE_CANONICAL map in geo_tximport.py).
    assert len(cell_line_warnings) >= 2, (
        f"expected at least 2 cell_line_normalized warnings "
        f"(MD-MBA-231 and MD-MBA-453); got {len(cell_line_warnings)}"
    )
    messages = [row["message"] for row in cell_line_warnings]
    assert any("MD-MBA-231" in msg and "MDA-MB-231" in msg for msg in messages), (
        f"no warning records the MD-MBA-231 → MDA-MB-231 correction; "
        f"messages: {messages}"
    )

    # warnings_metrics_consistency: warnings.csv row count must equal the
    # total warnings recorded in processing_log.csv ``warnings`` JSON arrays.
    proc_rows = _read_csv_sig(artifacts / "processing_log.csv")
    logged_warning_count = 0
    for prow in proc_rows:
        raw = prow.get("warnings", "[]")
        with contextlib.suppress(json.JSONDecodeError, TypeError):
            logged_warning_count += len(json.loads(raw))
    assert logged_warning_count == len(warning_rows), (
        f"warnings.csv row count ({len(warning_rows)}) must equal "
        f"processing_log warnings count ({logged_warning_count})"
    )


# ---------------------------------------------------------------------------
# §1.2 field_descriptions real semantics
# ---------------------------------------------------------------------------


def test_field_descriptions_have_real_semantics(tmp_path: Path) -> None:
    """``field_descriptions.csv`` must carry real semantic descriptions.

    Before §1.2, ``description = field.replace("_", " ")`` produced
    placeholders like ``"gene id namespace"``. Each required field must now
    have a description that is NOT just the field name with underscores
    replaced by spaces.
    """
    artifacts = _run_pinned_pipeline(tmp_path)
    desc_rows = _read_csv_sig(artifacts / "field_descriptions.csv")
    desc_by_field = {row["field_name"]: row for row in desc_rows}

    missing = _REQUIRED_FIELD_DESCRIPTIONS - set(desc_by_field)
    assert not missing, f"missing field_descriptions for: {missing}"

    for field in _REQUIRED_FIELD_DESCRIPTIONS:
        row = desc_by_field[field]
        placeholder = field.replace("_", " ")
        description = row["description"]
        assert description and description != placeholder, (
            f"field {field!r} description must be a real semantic string, "
            f"not the placeholder {placeholder!r}"
        )
        # data_type must not be uniformly "string" — numeric fields should
        # declare a numeric type.
        if field in {"expression_value", "source_line_number",
                     "source_column_index", "replicate"}:
            assert row["data_type"] != "string", (
                f"field {field!r} is numeric; data_type must not be 'string'"
            )


# ---------------------------------------------------------------------------
# §1.7 extrasaction="ignore" forbidden
# ---------------------------------------------------------------------------


def test_write_csv_rejects_extra_fields(tmp_path: Path) -> None:
    """``_write_csv`` must raise on rows with fields not in the column list.

    Before §1.7, ``extrasaction="ignore"`` silently dropped extra fields,
    which masked bugs where a row dict had a typo'd key. The writer must
    now raise ``ValueError`` so typos surface immediately.
    """
    path = tmp_path / "test.csv"
    columns = ["a", "b"]
    rows = [{"a": "1", "b": "2", "typo_field": "3"}]
    with pytest.raises(ValueError, match="typo_field|extra"):
        _write_csv_artifact(path, columns, rows)
    with pytest.raises(ValueError, match="typo_field|extra"):
        _write_csv_validation(path, columns, rows)
