"""Phase 4b T3: validation gate NO_DATA mode.

A no-primary staging package (T2 shape: NO ``main_data.csv`` /
``pathway_members.csv``, ``sample_metadata.csv`` supporting table, audit
CSVs, ``warnings.csv`` with a ``no_expression_data`` row folded into
``processing_log.csv``) must validate as NO_DATA — not as a failure and not
as a crash:

- ``load_validation_context`` tolerates the absence of BOTH primary files:
  ``main_rows=[]`` + ``no_primary=True``.
- ``validate_package`` runs a SEPARATE no_primary branch: the main-table
  checks (``main_data_nonempty`` / ``core_data_existence`` / ``foreign_keys``
  / ``source_value_lineage`` / reactome) are skipped entirely, a new decision
  check ``no_primary_data`` records the verified no-primary shape + reason,
  and the remaining checks run unchanged. The normal-mode check_id sequence
  stays byte-identical (pinned by ``test_validation_split.py``).
- Every check that dereferences ``main_rows`` is safe with ``main_rows=[]``.

Design choice (T3 review MUST-FIX, documented): NO_DATA is AUTHORIZED only by
the trusted upstream signal — ``ArtifactBuildOutput.no_primary_reason`` threaded
from ``run_validation`` into ``validate_package``. The staging shape (no primary
file) is the file-shape evidence the decision check asserts; the
``no_expression_data`` row in ``warnings.csv`` is evidence, not authorization.
A package missing the primary table WITHOUT the authorized reason is a broken
package and fails the gate; a package claiming NO_DATA while a primary file
exists is inconsistent and fails the gate. NO_DATA mode is active only when
BOTH the reason is non-empty AND no primary file exists.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.domain.contracts import (
    Database,
    DatasetSelection,
    TaskSpecification,
)
from app.domain.contracts.dataset_state import ArtifactRole
from app.pipeline.stages.base import ArtifactBuildOutput, StageContext
from app.pipeline.stages.validation import _validate_package
from app.pipeline.stages.validation.checks.lineage import check_source_value_lineage
from app.pipeline.stages.validation.checks.main_data import (
    check_cleaning_report_consistency,
    check_core_data_existence,
    check_field_descriptions,
    check_foreign_keys,
    check_main_data_nonempty,
    check_warnings_metrics_consistency,
)
from app.pipeline.stages.validation.checks.reactome import check_reactome
from app.pipeline.stages.validation.checks.relations import (
    check_source_relation_evidence,
)
from app.pipeline.stages.validation.checks.sample_metadata import (
    check_sample_foreign_keys,
)
from app.pipeline.stages.validation.checks.source_assets import (
    check_source_asset_integrity,
)
from app.pipeline.stages.validation.checks_common import (
    ValidationContext,
    load_validation_context,
)
from app.pipeline.stages.validation.runner import run_validation
from app.tools.workdir import create_task_workdir

_NO_DATA_REASON = "series_matrix_expression_empty_and_no_supplementary"

# The NO_DATA branch check_id sequence (a SEPARATE branch from the normal
# sequence pinned in test_validation_split.py).
_NO_DATA_CHECK_IDS = [
    "source_relation_evidence",
    "no_primary_data",
    "sample_foreign_keys",
    "source_asset_integrity",
    "field_descriptions",
    "warnings_metrics_consistency",
    "cleaning_report_consistency",
]

# Main-table checks that must never appear in NO_DATA mode.
_SKIPPED_MAIN_CHECK_IDS = [
    "main_data_nonempty",
    "core_data_existence",
    "foreign_keys",
    "source_value_lineage",
]

_MAIN_DATA_COLUMNS = [
    "record_id", "dataset_id", "source_id", "asset_id", "gene_id_raw",
    "gene_id", "gene_id_namespace", "gene_id_version", "sample_id",
    "source_sample_alias", "measurement_type", "value_semantics",
    "value_scale", "is_normalized", "is_integer_expected",
    "expression_value", "expression_unit", "source_logical_file",
    "source_line_number", "source_column_index", "source_column_name",
    "source_raw_value",
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
    "asset_id", "source_id", "successful_attempt_id", "derived_from_asset_id",
    "data_level", "relative_path", "size_bytes", "sha256", "media_type",
    "schema_version",
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

_FIELD_DESCRIPTION_COLUMNS = [
    "field_name", "data_type", "description", "unit", "nullable",
    "source", "example",
]


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _no_expression_warning() -> dict[str, object]:
    return {
        "warning_id": "warn_no_expression_data",
        "severity": "warning",
        "stage": "processing",
        "code": "no_expression_data",
        "message": (
            "未找到可发布的表达数据（原因: "
            f"{_NO_DATA_REASON}）；产物仅含样本元数据与审计报告；"
            "如需表达数据请更换数据集或检查数据集相关性"
        ),
        "source_id": "src_geo",
        "asset_id": "asset_1",
        "record_id": "",
        "created_at": "2026-01-01T00:00:00",
    }


def _build_no_data_staging(
    staging: Path,
    task_root: Path,
    *,
    with_no_expression_warning: bool = True,
    with_empty_main: bool = False,
) -> tuple[Path, Path]:
    """Build a T2-shaped NO_DATA staging package and return (staging, source_path).

    Mirrors what the artifact builder stages for a no-primary processing
    output: NO ``main_data.csv``, ``sample_metadata.csv`` supporting table,
    the audit CSVs, and ``warnings.csv`` with the ``no_expression_data``
    warning folded into ``processing_log.csv`` (so
    ``warnings_metrics_consistency`` stays satisfied). The source asset file
    is written on disk with matching sha256/size so
    ``source_asset_integrity`` passes.
    """
    source_path = task_root / "source_assets" / "GSE999999_series_matrix.txt.gz"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_content = gzip.compress(
        b"!Series_matrix_table_begin\ngene_id\tGSM9999991\tGSM9999992\n"
    )
    source_path.write_bytes(source_content)
    size_bytes = len(source_content)
    source_sha256 = hashlib.sha256(source_content).hexdigest()
    relative_path = source_path.relative_to(task_root).as_posix()

    staging.mkdir(parents=True, exist_ok=True)

    # dataset_catalog.csv: one GEO dataset owned by src_geo.
    _write_csv(staging / "dataset_catalog.csv", _DATASET_CATALOG_COLUMNS, [
        {"dataset_id": "ds1", "source_id": "src_geo", "database": "geo",
         "accession": "GSE999999", "title": "Test", "organism": "Homo sapiens",
         "experiment_type": "RNA-Seq", "sample_count": "2",
         "platform_ids": "[]", "related_pmids": "[]",
         "source_url": "https://example.test", "retrieved_at": "2026-01-01T00:00:00"},
    ])

    # sample_metadata.csv: the supporting table (samples recovered by
    # processing even though no expression matrix was published).
    _write_csv(staging / "sample_metadata.csv", _SAMPLE_METADATA_COLUMNS, [
        {"sample_id": "GSM9999991", "dataset_id": "ds1", "source_id": "src_geo",
         "source_sample_alias": "S1", "cell_line_raw": "",
         "cell_line_canonical": "", "normalization_rule": "",
         "treatment": "control", "replicate": "1", "organism": "Homo sapiens",
         "source_url": "https://example.test"},
        {"sample_id": "GSM9999992", "dataset_id": "ds1", "source_id": "src_geo",
         "source_sample_alias": "S2", "cell_line_raw": "",
         "cell_line_canonical": "", "normalization_rule": "",
         "treatment": "treated", "replicate": "1", "organism": "Homo sapiens",
         "source_url": "https://example.test"},
    ])

    # source_list.csv + source_relations.csv (header-only for a single GEO
    # source without literature evidence).
    _write_csv(staging / "source_list.csv", _SOURCE_LIST_COLUMNS, [
        {"source_id": "src_geo", "database": "geo", "accession": "GSE999999",
         "url": "https://example.test", "title": "Test",
         "retrieved_at": "2026-01-01T00:00:00"},
    ])
    _write_csv(staging / "source_relations.csv", _SOURCE_RELATION_COLUMNS, [])

    # source_assets.csv + download_log.csv: the real on-disk asset with a
    # successful download attempt.
    _write_csv(staging / "source_assets.csv", _SOURCE_ASSET_COLUMNS, [
        {"asset_id": "asset_1", "source_id": "src_geo",
         "successful_attempt_id": "attempt_1", "derived_from_asset_id": "",
         "data_level": "repository_processed", "relative_path": relative_path,
         "size_bytes": size_bytes, "sha256": source_sha256,
         "media_type": "application/gzip", "schema_version": "1.0"},
    ])
    _write_csv(staging / "download_log.csv", _DOWNLOAD_LOG_COLUMNS, [
        {"attempt_id": "attempt_1", "source_id": "src_geo",
         "url": "https://example.test/file.gz", "status": "succeeded",
         "bytes_received": size_bytes, "error_code": "",
         "error_message": "", "started_at": "2026-01-01T00:00:00",
         "finished_at": "2026-01-01T00:00:01"},
    ])

    # field_descriptions.csv covers the supporting table columns (the main
    # table does not exist, so check_field_descriptions vacuous-passes).
    _write_csv(staging / "field_descriptions.csv", _FIELD_DESCRIPTION_COLUMNS, [
        {"field_name": col, "data_type": "string", "description": col,
         "unit": "", "nullable": "false", "source": "test", "example": ""}
        for col in _SAMPLE_METADATA_COLUMNS
    ])

    # warnings.csv + processing_log.csv: the no_expression_data warning is
    # folded into the synthetic no_primary processing row so
    # warnings_metrics_consistency stays satisfied (T2).
    if with_no_expression_warning:
        warning = _no_expression_warning()
        warning_rows = [warning]
        folded = [{"warning_id": "warn_no_expression_data",
                   "code": "no_expression_data",
                   "message": warning["message"]}]
        operation = "no_primary"
    else:
        warning_rows = []
        folded = []
        operation = "no_primary"
    _write_csv(staging / "warnings.csv", _WARNINGS_COLUMNS, warning_rows)
    _write_csv(staging / "processing_log.csv", _PROCESSING_LOG_COLUMNS, [
        {"step_id": "step_processing_no_primary", "stage_attempt_id": "attempt_test",
         "stage": "processing", "operation": operation,
         "input_refs": "[\"asset_1\"]", "output_refs": "[]",
         "tool_version": "1.0.0", "rows_before": 0, "rows_after": 0,
         "parameters": json.dumps({"no_primary_reason": _NO_DATA_REASON},
                                  sort_keys=True),
         "status": "succeeded", "started_at": "2026-01-01T00:00:00",
         "finished_at": "2026-01-01T00:00:01",
         "warnings": json.dumps(folded)},
    ])

    # cleaning_report.csv: header-only (no anomalies).
    _write_csv(staging / "cleaning_report.csv", _CLEANING_REPORT_COLUMNS, [])

    # field_mapping.csv: header-only (NO_DATA packages have no values to map).
    _write_csv(staging / "field_mapping.csv", ["dataset_id", "source_id", "field_name", "mapped_to"], [])

    # Optional empty main table (a file EXISTS but has 0 rows): this is NOT
    # no_primary — an empty table must fail the gate, never validate as
    # NO_DATA (ADR-011 空表不发布).
    if with_empty_main:
        _write_csv(staging / "main_data.csv", _MAIN_DATA_COLUMNS, [])

    return staging, source_path


def _specification() -> TaskSpecification:
    return TaskSpecification(
        topic="GSE999999",
        datasets=[
            DatasetSelection(
                dataset_id="ds1",
                database=Database.GEO,
                accession="GSE999999",
                reason="explicit",
                source_id="src_geo",
            )
        ],
    )


def _check_by_id(checks: list[dict], check_id: str) -> dict:
    return next(c for c in checks if c["check_id"] == check_id)


# ---------------------------------------------------------------------------
# NO_DATA package validates as NO_DATA (decision record, not failure)
# ---------------------------------------------------------------------------


def test_no_data_package_validates_as_no_data(tmp_path: Path) -> None:
    """A T2-shaped no-primary staging package validates as NO_DATA: status
    valid, failed_count 0, the ``no_primary_data`` decision check appears and
    the main-table checks are skipped entirely. The authorized upstream
    reason is threaded via the ``no_primary_reason`` parameter; the
    warnings.csv evidence row is recorded as evidence only."""
    task_root = tmp_path / "tasks" / "task_no_data"
    staging, source_path = _build_no_data_staging(
        staging=task_root / "staging", task_root=task_root
    )

    summary, checks = _validate_package(
        staging,
        source_path,
        task_root / "logs" / "validation.json",
        no_primary_reason=_NO_DATA_REASON,
    )

    assert summary.status == "valid"
    assert summary.failed_count == 0
    actual_ids = [str(c["check_id"]) for c in checks]
    assert actual_ids == _NO_DATA_CHECK_IDS, actual_ids
    # Main-table checks must never run in NO_DATA mode.
    for check_id in _SKIPPED_MAIN_CHECK_IDS:
        assert check_id not in actual_ids, (
            f"{check_id} must be skipped in NO_DATA mode"
        )
    decision = _check_by_id(checks, "no_primary_data")
    assert decision["status"] == "passed"
    assert decision["failed_count"] == 0
    # The decision record carries the reason from warnings.csv.
    assert _NO_DATA_REASON in str(decision["details"])


def test_authorized_no_data_without_warning_valid(tmp_path: Path) -> None:
    """A no-primary package with the AUTHORIZED upstream reason but NO
    warnings.csv evidence row still validates as NO_DATA: the authorized
    reason is recorded (the warning row is evidence, not authorization; the
    generic fallback never applies when authorization exists)."""
    task_root = tmp_path / "tasks" / "task_no_data_authorized"
    staging, source_path = _build_no_data_staging(
        staging=task_root / "staging",
        task_root=task_root,
        with_no_expression_warning=False,
    )

    summary, checks = _validate_package(
        staging,
        source_path,
        task_root / "logs" / "validation.json",
        no_primary_reason=_NO_DATA_REASON,
    )

    assert summary.status == "valid"
    assert summary.failed_count == 0
    actual_ids = [str(c["check_id"]) for c in checks]
    assert actual_ids == _NO_DATA_CHECK_IDS, actual_ids
    decision = _check_by_id(checks, "no_primary_data")
    assert decision["status"] == "passed"
    # The AUTHORIZED reason is recorded — not a generic fallback.
    assert _NO_DATA_REASON in str(decision["details"])
    assert "no primary dataset in staging package" not in str(decision["details"])


def test_missing_primary_without_authorization_rejected(tmp_path: Path) -> None:
    """T3 MUST-FIX: a package missing the primary table WITHOUT the trusted
    upstream reason is a BROKEN package, not NO_DATA — the gate rejects it
    even when warnings.csv carries a no_expression_data row (the warning row
    is evidence, not authorization)."""
    task_root = tmp_path / "tasks" / "task_no_primary_unauthorized"
    staging, source_path = _build_no_data_staging(
        staging=task_root / "staging",
        task_root=task_root,
        with_no_expression_warning=True,
    )

    summary, checks = _validate_package(
        staging, source_path, task_root / "logs" / "validation.json"
    )

    assert summary.status == "invalid"
    actual_ids = [str(c["check_id"]) for c in checks]
    # No-primary branch runs (main-table checks absent) but the decision
    # check FAILS: missing primary without NO_DATA authorization.
    for check_id in _SKIPPED_MAIN_CHECK_IDS:
        assert check_id not in actual_ids, check_id
    decision = _check_by_id(checks, "no_primary_data")
    assert decision["status"] == "failed"
    assert decision["failed_count"] == 1
    assert "authorization" in str(decision["details"])


def test_reason_with_primary_present_rejected(tmp_path: Path) -> None:
    """T3 MUST-FIX: a package that claims NO_DATA upstream while a primary
    file EXISTS is inconsistent and must FAIL — the decision check reports
    the conflict instead of papering over it."""
    task_root = tmp_path / "tasks" / "task_no_data_conflict"
    staging, source_path = _build_no_data_staging(
        staging=task_root / "staging",
        task_root=task_root,
        with_empty_main=True,
    )

    summary, checks = _validate_package(
        staging,
        source_path,
        task_root / "logs" / "validation.json",
        no_primary_reason=_NO_DATA_REASON,
    )

    assert summary.status == "invalid"
    actual_ids = [str(c["check_id"]) for c in checks]
    # Normal branch runs (a primary file exists) PLUS the failing conflict
    # decision check.
    assert "main_data_nonempty" in actual_ids
    assert "no_primary_data" in actual_ids
    decision = _check_by_id(checks, "no_primary_data")
    assert decision["status"] == "failed"
    assert decision["failed_count"] == 1
    details = str(decision["details"])
    assert "primary file" in details
    assert _NO_DATA_REASON in details

def test_empty_main_data_file_is_not_no_primary(tmp_path: Path) -> None:
    """A ``main_data.csv`` that EXISTS but has 0 rows is NOT no_primary (a
    file exists): the normal branch runs and ``main_data_nonempty`` FAILS —
    an empty table cannot pass the gate (ADR-011 空表不发布)."""
    task_root = tmp_path / "tasks" / "task_empty_main"
    staging, source_path = _build_no_data_staging(
        staging=task_root / "staging",
        task_root=task_root,
        with_empty_main=True,
    )

    ctx = load_validation_context(staging, source_path, task_root / "logs" / "c.json")
    assert ctx.no_primary is False

    summary, checks = _validate_package(
        staging, source_path, task_root / "logs" / "validation.json"
    )

    assert summary.status == "invalid"
    actual_ids = [str(c["check_id"]) for c in checks]
    # Normal branch: main-table checks present, decision check absent.
    assert "main_data_nonempty" in actual_ids
    assert "no_primary_data" not in actual_ids
    nonempty = _check_by_id(checks, "main_data_nonempty")
    assert nonempty["status"] == "failed"
    assert nonempty["failed_count"] == 1
    assert nonempty["checked_count"] == 0


# ---------------------------------------------------------------------------
# load_validation_context no_primary flag
# ---------------------------------------------------------------------------


def test_validation_context_no_primary_flag(tmp_path: Path) -> None:
    """load_validation_context must tolerate the absence of BOTH primary files:
    main_rows=[] + no_primary=True (no crash), and no_primary=False when a
    primary file exists."""
    task_root = tmp_path / "tasks" / "task_ctx"
    staging, source_path = _build_no_data_staging(
        staging=task_root / "staging", task_root=task_root
    )
    ctx = load_validation_context(staging, source_path, task_root / "logs" / "c.json")
    assert isinstance(ctx, ValidationContext)
    assert ctx.no_primary is True
    assert ctx.main_rows == []
    assert not (staging / "main_data.csv").exists()
    assert not (staging / "pathway_members.csv").exists()
    # Supporting tables still load.
    assert ctx.sample_rows
    assert ctx.dataset_ids == {"ds1"}
    assert ctx.reactome_rows is False


# ---------------------------------------------------------------------------
# main_rows=[] safety: every check that dereferences main_rows must not crash
# ---------------------------------------------------------------------------


def test_checks_are_safe_with_empty_main_rows(tmp_path: Path) -> None:
    """Every check that dereferences ``main_rows`` must be safe with
    ``main_rows=[]`` (the NO_DATA context): no IndexError on ``main_rows[0]``,
    and each check returns a well-formed record."""
    task_root = tmp_path / "tasks" / "task_empty_rows"
    staging, source_path = _build_no_data_staging(
        staging=task_root / "staging", task_root=task_root
    )
    ctx = load_validation_context(staging, source_path, task_root / "logs" / "c.json")
    assert ctx.no_primary is True
    assert ctx.main_rows == []

    # Main-table checks: safe with [] even though validate_package skips them
    # in NO_DATA mode (they must never crash if called directly).
    nonempty = check_main_data_nonempty(ctx)
    assert nonempty["status"] == "failed" and nonempty["failed_count"] == 1
    core = check_core_data_existence(ctx)
    assert core["status"] == "failed" and core["failed_count"] == 1
    fk = check_foreign_keys(ctx)
    assert fk["status"] == "passed" and fk["checked_count"] == 0
    lineage = check_source_value_lineage(ctx)
    assert lineage["status"] == "passed" and lineage["checked_count"] == 0
    fields = check_field_descriptions(ctx)
    assert fields["status"] == "passed" and fields["checked_count"] == 0
    assert check_reactome(ctx) == []

    # Supporting checks keep running in NO_DATA mode and stay green.
    for check in (
        check_source_relation_evidence(ctx),
        check_sample_foreign_keys(ctx),
        check_source_asset_integrity(ctx),
        check_warnings_metrics_consistency(ctx),
        check_cleaning_report_consistency(ctx),
    ):
        assert check["status"] == "passed", check["check_id"]
        assert check["failed_count"] == 0


# ---------------------------------------------------------------------------
# run_validation manifest with the NO_DATA file set (no PRIMARY_DATASET role)
# ---------------------------------------------------------------------------


def test_run_validation_manifest_builds_without_primary(tmp_path: Path) -> None:
    """run_validation must build the RunManifest from the NO_DATA staging file
    set without crashing: entries carry no PRIMARY_DATASET role (there is no
    main_data.csv), quality_report.csv is written, and the validation summary
    is valid."""
    ctx = StageContext(
        task_id="task_no_data_validate",
        workdir=create_task_workdir(
            "task_no_data_validate", base_dir=str(tmp_path / "tasks")
        ),
        fixture_dir=tmp_path,
        topic="GSE999999",
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["geo"],
        specification=_specification(),
    )
    staging = ctx.workdir.staging_run(ctx.run_id)
    source_path = _build_no_data_staging(
        staging=staging, task_root=ctx.workdir.root
    )[1]

    build_output = ArtifactBuildOutput(
        staging_dir=staging,
        artifact_paths=sorted(staging.iterdir()),
        source_assets=[],
        source_path=source_path,
        literature=None,
        geo=None,
        specification=ctx.specification,
        sources=[],
        parsed_datasets=[],
        samples=[],
        download_attempts=[],
        retrieved_at=datetime.now(UTC),
        started_at=ctx.started_at,
        dataset_source_id="src_geo",
        dataset_accession="GSE999999",
        dataset_id="ds1",
        no_primary_reason=_NO_DATA_REASON,
    )
    result = run_validation(
        ctx,
        build_output,
        stage_attempts=[],
        stage_attempt_id="attempt_build",
        publish=False,
    )

    assert result.output.validation.status == "valid"
    assert (staging / "quality_report.csv").is_file()
    roles = [entry.role for entry in result.output.manifest.artifacts]
    assert ArtifactRole.PRIMARY_DATASET not in roles
    assert result.output.manifest.artifacts, "manifest must list staging files"


def test_run_validation_rejects_no_primary_without_signal(tmp_path: Path) -> None:
    """T3 MUST-FIX regression at the entry point: run_validation must read
    ``ArtifactBuildOutput.no_primary_reason``. A no-primary staging whose
    build output carries NO reason (e.g. a normal package whose main_data.csv
    accidentally disappeared) must FAIL the validation gate — never validate
    as a fabricated NO_DATA publication."""
    ctx = StageContext(
        task_id="task_no_data_unauthorized_validate",
        workdir=create_task_workdir(
            "task_no_data_unauthorized_validate",
            base_dir=str(tmp_path / "tasks"),
        ),
        fixture_dir=tmp_path,
        topic="GSE999999",
        started_at=datetime.now(UTC),
        mode="fixture",
        databases=["geo"],
        specification=_specification(),
    )
    staging = ctx.workdir.staging_run(ctx.run_id)
    source_path = _build_no_data_staging(
        staging=staging, task_root=ctx.workdir.root
    )[1]

    # Note: no ``no_primary_reason`` — the default None means the build
    # output carries NO trusted NO_DATA signal.
    build_output = ArtifactBuildOutput(
        staging_dir=staging,
        artifact_paths=sorted(staging.iterdir()),
        source_assets=[],
        source_path=source_path,
        literature=None,
        geo=None,
        specification=ctx.specification,
        sources=[],
        parsed_datasets=[],
        samples=[],
        download_attempts=[],
        retrieved_at=datetime.now(UTC),
        started_at=ctx.started_at,
        dataset_source_id="src_geo",
        dataset_accession="GSE999999",
        dataset_id="ds1",
    )

    with pytest.raises(ValueError, match="validation gate rejected the package"):
        run_validation(
            ctx,
            build_output,
            stage_attempts=[],
            stage_attempt_id="attempt_build",
            publish=False,
        )
