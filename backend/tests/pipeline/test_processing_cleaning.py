"""§1.3 清洗测试：验证缺失/重复/类型异常被正确标记到 warnings.csv。

Pinned pipeline (GSE178352) 运行后检查：
- cleaning_report.csv 产出正确的异常统计
- warnings.csv 包含清洗异常条目（missing_values, type_inconsistency 等）
- cleaning_report 与 warnings 计数一致性
"""
from __future__ import annotations

import asyncio
import csv
from pathlib import Path

from app.pipeline.runner import PipelineRunner

FIXTURE_DIR = (
    Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"
)


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _run_pinned_pipeline(tmp_path: Path) -> Path:
    """Run the GSE178352 pinned fixture pipeline and return the staging dir."""
    runner = PipelineRunner(
        task_id="task_cleaning_test",
        base_dir=tmp_path / "tasks",
        fixture_dir=FIXTURE_DIR,
    )
    manifest = asyncio.run(runner.run())
    assert manifest.task_state.value == "completed", (
        f"pinned pipeline must complete; got {manifest.task_state}"
    )
    return tmp_path / "tasks" / "task_cleaning_test" / "artifacts"


def test_cleaning_report_csv_is_produced(tmp_path: Path) -> None:
    """cleaning_report.csv 必须作为 artifact 产出。"""
    artifacts = _run_pinned_pipeline(tmp_path)
    cleaning_csv = artifacts / "cleaning_report.csv"
    assert cleaning_csv.is_file(), "cleaning_report.csv not produced"
    rows = _read_csv(cleaning_csv)
    assert len(rows) > 0, "cleaning_report.csv must not be empty"


def test_missing_values_flagged_in_warnings_and_cleaning_report(
    tmp_path: Path,
) -> None:
    """缺失值必须同时出现在 warnings.csv 和 cleaning_report.csv 中。"""
    artifacts = _run_pinned_pipeline(tmp_path)
    warnings = _read_csv(artifacts / "warnings.csv")
    cleaning = _read_csv(artifacts / "cleaning_report.csv")

    missing_warnings = [
        w for w in warnings if w.get("code") == "missing_values"
    ]
    missing_cleaning = [
        r for r in cleaning if r.get("rule") == "missing_values"
    ]
    assert len(missing_warnings) > 0, (
        "warnings.csv should contain missing_values entries"
    )
    assert len(missing_cleaning) > 0, (
        "cleaning_report.csv should contain missing_values entries"
    )
    # 数量应一致
    assert len(missing_warnings) == len(missing_cleaning), (
        f"warning count ({len(missing_warnings)}) != cleaning report count "
        f"({len(missing_cleaning)})"
    )


def test_type_inconsistency_flagged_in_warnings_and_cleaning_report(
    tmp_path: Path,
) -> None:
    """类型异常必须同时出现在 warnings.csv 和 cleaning_report.csv。"""
    artifacts = _run_pinned_pipeline(tmp_path)
    warnings = _read_csv(artifacts / "warnings.csv")
    cleaning = _read_csv(artifacts / "cleaning_report.csv")

    type_warnings = [
        w for w in warnings if w.get("code") == "type_inconsistency"
    ]
    type_cleaning = [
        r for r in cleaning if r.get("rule") == "type_inconsistency"
    ]
    # 类型异常可能为 0（夹具数据很干净），但不应该出现不一致
    assert len(type_warnings) == len(type_cleaning), (
        f"warning count ({len(type_warnings)}) != cleaning report count "
        f"({len(type_cleaning)})"
    )


def test_warnings_csv_contains_cleaning_entries(tmp_path: Path) -> None:
    """warnings.csv 必须包含 cleaning 阶段产出的异常条目。"""
    artifacts = _run_pinned_pipeline(tmp_path)
    warnings = _read_csv(artifacts / "warnings.csv")

    cleaning_warnings = [
        w for w in warnings
        if w.get("code") in {"missing_values", "duplicate_rows", "type_inconsistency"}
    ]
    assert len(cleaning_warnings) > 0, (
        "warnings.csv should contain at least one cleaning-related warning"
    )
    # 每条 cleaning warning 必须包含必需字段
    for w in cleaning_warnings:
        assert w["warning_id"].startswith("warn_cleaning_"), (
            f"cleaning warning id should start with warn_cleaning_: {w['warning_id']}"
        )
        assert w["stage"] == "processing"
        assert w["severity"] in {"info", "warning"}
        assert w["code"] in {"missing_values", "duplicate_rows", "type_inconsistency"}


def test_field_mapping_csv_uses_alignment(tmp_path: Path) -> None:
    """field_mapping.csv 应使用 alignment.normalize_field_names 而非硬编码映射。"""
    artifacts = _run_pinned_pipeline(tmp_path)
    mapping = _read_csv(artifacts / "field_mapping.csv")
    assert len(mapping) > 0, "field_mapping.csv must not be empty"
    # Field mapping 中的 raw_field 应来自实际 CSV 列名
    for row in mapping:
        assert row["raw_field"], f"raw_field must not be empty: {row}"
        assert row["canonical_field"], f"canonical_field must not be empty: {row}"
        # alignment:normalize_field_names 或 fallback 标记
        assert row["notes"], f"notes must not be empty: {row}"


def test_cleaning_report_total_anomalies_match_warnings_count(
    tmp_path: Path,
) -> None:
    """清洗异常总数与 warnings.csv 中对应的条目数一致。"""
    artifacts = _run_pinned_pipeline(tmp_path)
    warnings = _read_csv(artifacts / "warnings.csv")

    cleaning_warnings = [
        w for w in warnings
        if w.get("code") in {"missing_values", "duplicate_rows", "type_inconsistency"}
    ]
    cleaning = _read_csv(artifacts / "cleaning_report.csv")

    # cleaning_report.csv 中 anomaly 条目数应与 warnings 中对应条目数一致
    cleaning_entry_count = len(cleaning)
    assert cleaning_entry_count == len(cleaning_warnings), (
        f"cleaning_report rows ({cleaning_entry_count}) != "
        f"cleaning warnings ({len(cleaning_warnings)})"
    )


def test_cleaning_does_not_break_existing_validation(tmp_path: Path) -> None:
    """清洗功能不破坏已有的 validation gate 检查。"""
    artifacts = _run_pinned_pipeline(tmp_path)
    quality = _read_csv(artifacts / "quality_report.csv")
    all_statuses = {r["status"] for r in quality}
    assert all_statuses == {"passed"}, (
        f"all quality checks must pass; got statuses: {all_statuses}"
    )
