"""REVIEW 2026-08-05 P0-1：清洗截断必须可见，不再静默丢失数据。

覆盖三条链路：
1. ``_clean_parsed_dataset`` 超过行数上限时记录 ``truncated_rows`` + anomaly flag；
2. ``_build_warnings_rows`` 将截断写入 ``warnings.csv``（code=cleaning_truncated）；
3. ``_build_cleaning_report_rows`` 将截断写入 ``cleaning_report.csv``（rule=truncated_rows）。
"""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

from app.domain.contracts import FileAsset, ParsedDataset, asset_id_from_sha256
from app.pipeline.stages import processing as processing_module
from app.pipeline.stages.artifact_build.cleaning import _build_cleaning_report_rows
from app.pipeline.stages.artifact_build.warnings import _build_warnings_rows
from app.pipeline.stages.base import CleaningReportModel, StageContext
from app.pipeline.stages.processing import _clean_parsed_dataset
from app.tools.workdir import create_task_workdir


def _make_parsed(
    workdir,
    rows: list[str],
    columns: list[str],
    dataset_id: str = "dataset_trunc",
) -> ParsedDataset:
    csv_path = workdir.parsed / "big.csv"
    csv_path.write_text(
        "\n".join([",".join(columns), *rows]) + "\n",
        encoding="utf-8",
    )
    original = csv_path.read_bytes()
    checksum = hashlib.sha256(original).hexdigest()
    return ParsedDataset(
        dataset_id=dataset_id,
        source_id="source_trunc",
        source_asset_id="asset_trunc",
        file_asset=FileAsset(
            asset_id=asset_id_from_sha256(checksum),
            kind="parsed",
            relative_path="parsed/big.csv",
            sha256=checksum,
            size_bytes=len(original),
            media_type="text/csv",
            generated_by_step_id="step_parser",
        ),
        columns=columns,
        row_count=len(rows),
        parser_name="test_parser",
        parser_version="1.0",
        source_row_count=len(rows),
    )


def _ctx(tmp_path: Path, workdir, task_id: str = "task_trunc") -> StageContext:
    return StageContext(
        task_id=task_id,
        workdir=workdir,
        fixture_dir=tmp_path,
        topic="truncation",
        started_at=datetime.now(UTC),
    )


def test_cleaning_records_truncated_rows_when_limit_hit(
    tmp_path: Path, monkeypatch
) -> None:
    """超过清洗行数上限必须记录 truncated_rows 与 anomaly flag，不再静默丢弃。"""
    monkeypatch.setattr(processing_module, "_CLEANING_MAX_ROWS", 3)
    workdir = create_task_workdir("task_trunc", root_dir=tmp_path / "task")
    parsed = _make_parsed(
        workdir,
        ["S1,1", "S2,2", "S3,3", "S4,4", "S5,5"],
        ["sample", "value"],
    )

    _, report = _clean_parsed_dataset(_ctx(tmp_path, workdir), parsed)

    assert report.truncated_rows == 2, (
        f"expected 2 truncated rows, got {report.truncated_rows}"
    )
    assert any("截断" in flag for flag in report.anomaly_flags), (
        f"anomaly_flags must mention truncation; got {report.anomaly_flags}"
    )
    # 未达上限的 3 行正常处理，无缺失/重复误报
    assert report.missing_stats == {}
    assert report.duplicate_count == 0


def test_cleaning_below_limit_records_zero_truncation(
    tmp_path: Path, monkeypatch
) -> None:
    """未达上限时不记录截断，行为与历史一致。"""
    monkeypatch.setattr(processing_module, "_CLEANING_MAX_ROWS", 100)
    workdir = create_task_workdir("task_trunc_ok", root_dir=tmp_path / "task")
    parsed = _make_parsed(
        workdir,
        ["S1,1", "S2,2", "S3,3"],
        ["sample", "value"],
    )

    _, report = _clean_parsed_dataset(_ctx(tmp_path, workdir), parsed)

    assert report.truncated_rows == 0
    assert not any("截断" in flag for flag in report.anomaly_flags)


def test_cleaning_stats_are_complete_under_streaming(
    tmp_path: Path, monkeypatch
) -> None:
    """流式清洗统计必须覆盖全部行（不再按前 500k 截断导致系统性低估）。

    构造 6 行混合数据（含 trim/缺失/重复/类型不一致），阈值设高使其全部
    参与统计，验证各指标精确。
    """
    monkeypatch.setattr(processing_module, "_CLEANING_MAX_ROWS", 1_000_000)
    workdir = create_task_workdir("task_stream", root_dir=tmp_path / "task")
    parsed = _make_parsed(
        workdir,
        [
            " S1 , 1 , keep ",   # trim 2 列 + 1 空
            "S1,1,keep",          # 重复行
            "S2,N/A,abc",         # N/A → 空
            "S3,2,def",           # 数值
            "S4,x,ghi",           # value 列类型不一致（int 占 4/5 多数时被 flag）
            "S5,3,jkl",
            "S6,4,mno",
        ],
        ["sample", "value", "note"],
    )

    cleaned, report = _clean_parsed_dataset(_ctx(tmp_path, workdir), parsed)

    assert report.truncated_rows == 0
    assert report.duplicate_count == 1
    assert report.format_corrections["trimmed_values"] >= 2
    assert report.format_corrections["normalized_missing_values"] == 1
    # 去重后 6 行；value 列 int 占 4/5（>=0.8 阈值），S4=x 为类型不一致
    assert cleaned.row_count == 6
    assert report.type_issues.get("value") == 1, (
        f"type_issues must flag the non-numeric value; got {report.type_issues}"
    )
    assert report.missing_stats.get("value") == 1, (
        f"missing_stats must count the N/A→empty value; got {report.missing_stats}"
    )


def test_truncation_appears_in_warnings_rows() -> None:
    """截断必须写入 warnings.csv 条目（code=cleaning_truncated），用户/Agent 可见。"""
    report = CleaningReportModel(truncated_rows=7)
    rows = _build_warnings_rows(
        cell_line_warnings=[],
        cleaning_report=report,
        geo_source_id="src",
        asset_id="asset",
        retrieved_at=datetime.now(UTC),
    )
    truncated = [r for r in rows if r["code"] == "cleaning_truncated"]
    assert len(truncated) == 1, f"expected 1 cleaning_truncated warning; got {rows}"
    assert truncated[0]["severity"] == "warning"
    assert "7" in str(truncated[0]["message"])
    # 未截断时不产出该条目
    rows_ok = _build_warnings_rows(
        cell_line_warnings=[],
        cleaning_report=CleaningReportModel(),
        geo_source_id="src",
        asset_id="asset",
        retrieved_at=datetime.now(UTC),
    )
    assert not [r for r in rows_ok if r["code"] == "cleaning_truncated"]


def test_truncation_appears_in_cleaning_report_rows() -> None:
    """截断必须写入 cleaning_report.csv（rule=truncated_rows）。"""
    report = CleaningReportModel(truncated_rows=7)
    rows = _build_cleaning_report_rows(report)
    truncated = [r for r in rows if r["rule"] == "truncated_rows"]
    assert len(truncated) == 1
    assert "7" in str(truncated[0]["affected_count"])
    # 未截断时无该条目
    rows_ok = _build_cleaning_report_rows(CleaningReportModel())
    assert not [r for r in rows_ok if r["rule"] == "truncated_rows"]
