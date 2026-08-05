"""Cleaning report CSV building helper.

Builds ``cleaning_report.csv`` rows from the cleaning analysis produced during
the processing stage (TODO §1.7).
"""
from __future__ import annotations

from app.pipeline.stages.base import CleaningReportModel


def _build_cleaning_report_rows(
    cleaning_report: CleaningReportModel | None,
) -> list[dict[str, object]]:
    """Build ``cleaning_report.csv`` rows from the cleaning analysis."""
    if cleaning_report is None:
        return []

    rows: list[dict[str, object]] = []

    # Missing values per column
    for col, count in cleaning_report.missing_stats.items():
        rows.append({
            "rule": "missing_values",
            "field_name": col,
            "affected_count": str(count),
            "message": f"字段 '{col}' 有 {count} 个缺失值",
        })

    # Duplicates
    if cleaning_report.duplicate_count > 0:
        rows.append({
            "rule": "duplicate_rows",
            "field_name": "",
            "affected_count": str(cleaning_report.duplicate_count),
            "message": f"检测到 {cleaning_report.duplicate_count} 个精确重复行",
        })

    # Type issues per column
    for col, count in cleaning_report.type_issues.items():
        rows.append({
            "rule": "type_inconsistency",
            "field_name": col,
            "affected_count": str(count),
            "message": f"字段 '{col}' 有 {count} 个类型不匹配值",
        })

    # Truncation (REVIEW 2026-08-05 P0-1): 数据被截断必须可见
    if cleaning_report.truncated_rows > 0:
        rows.append({
            "rule": "truncated_rows",
            "field_name": "",
            "affected_count": str(cleaning_report.truncated_rows),
            "message": (
                f"数据行数超过清洗上限，截断 {cleaning_report.truncated_rows} 行，"
                "产物可能不完整"
            ),
        })

    return rows
