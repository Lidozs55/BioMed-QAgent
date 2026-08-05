"""Validation warnings CSV building helpers.

Builds ``warnings.csv`` rows from cell-line canonicalization corrections
(processing stage) merged with cleaning anomalies so
``warnings_metrics_consistency`` validation stays satisfied (TODO §1.7).
"""
from __future__ import annotations

from datetime import datetime

from app.pipeline.processing.geo_tximport import GeoSampleMetadata
from app.pipeline.stages.base import CleaningReportModel


def _build_cell_line_warnings(
    samples: list[GeoSampleMetadata],
    geo_source_id: str,
    asset_id: str,
    retrieved_at: datetime,
) -> list[dict[str, object]]:
    """Build warnings.csv rows for cell-line canonicalization corrections.

    Each sample whose ``cell_line_raw != cell_line_canonical`` produces one
    warning row with ``code="cell_line_normalized"`` so judges can audit the
    normalization applied during processing (TODO §1.7).
    """
    warnings: list[dict[str, object]] = []
    for sample in samples:
        if sample.cell_line_raw and sample.cell_line_raw != sample.cell_line_canonical:
            warnings.append({
                "warning_id": f"warn_cell_line_{sample.sample_id.lower()}",
                "severity": "info",
                "stage": "processing",
                "code": "cell_line_normalized",
                "message": f"{sample.cell_line_raw} → {sample.cell_line_canonical}",
                "source_id": geo_source_id,
                "asset_id": asset_id,
                "record_id": sample.sample_id,
                "created_at": retrieved_at.isoformat(),
            })
    return warnings


def _build_warnings_rows(
    cell_line_warnings: list[dict[str, object]],
    cleaning_report: CleaningReportModel | None,
    geo_source_id: str,
    asset_id: str,
    retrieved_at: datetime,
) -> list[dict[str, object]]:
    """Merge cell-line warnings with cleaning anomalies into ``warnings.csv``."""
    warnings: list[dict[str, object]] = list(cell_line_warnings)

    if cleaning_report is None:
        return warnings

    idx = 0
    # Missing values → warnings
    for col, count in cleaning_report.missing_stats.items():
        warnings.append({
            "warning_id": f"warn_cleaning_{idx}",
            "severity": "info",
            "stage": "processing",
            "code": "missing_values",
            "message": f"字段 '{col}' 有 {count} 个缺失值",
            "source_id": geo_source_id,
            "asset_id": asset_id,
            "record_id": "",
            "created_at": retrieved_at.isoformat(),
        })
        idx += 1

    # Duplicates → warnings
    if cleaning_report.duplicate_count > 0:
        warnings.append({
            "warning_id": f"warn_cleaning_{idx}",
            "severity": "warning",
            "stage": "processing",
            "code": "duplicate_rows",
            "message": f"检测到 {cleaning_report.duplicate_count} 个精确重复行",
            "source_id": geo_source_id,
            "asset_id": asset_id,
            "record_id": "",
            "created_at": retrieved_at.isoformat(),
        })
        idx += 1

    # Type issues → warnings
    for col, count in cleaning_report.type_issues.items():
        warnings.append({
            "warning_id": f"warn_cleaning_{idx}",
            "severity": "warning",
            "stage": "processing",
            "code": "type_inconsistency",
            "message": f"字段 '{col}' 有 {count} 个类型不匹配值",
            "source_id": geo_source_id,
            "asset_id": asset_id,
            "record_id": "",
            "created_at": retrieved_at.isoformat(),
        })
        idx += 1

    # Truncation → warning (REVIEW 2026-08-05 P0-1): 数据被截断必须可见
    if cleaning_report.truncated_rows > 0:
        warnings.append({
            "warning_id": f"warn_cleaning_{idx}",
            "severity": "warning",
            "stage": "processing",
            "code": "cleaning_truncated",
            "message": (
                f"数据行数超过清洗上限，截断 {cleaning_report.truncated_rows} 行，"
                "产物可能不完整"
            ),
            "source_id": geo_source_id,
            "asset_id": asset_id,
            "record_id": "",
            "created_at": retrieved_at.isoformat(),
        })

    return warnings
