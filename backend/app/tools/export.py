"""导出工具 — 将 OutputBundle 中的数据写入 CSV 文件。

对应 TODO.md Section 11：
- 主数据 CSV（每条记录关联来源和 raw 文件）
- 字段说明 CSV
- 来源清单 CSV
- 处理记录 CSV
- warnings CSV

所有导出文件写入 task artifacts 目录，不覆盖 raw 文件。
"""
from __future__ import annotations

import csv
from pathlib import Path

from app.domain.output import (
    DataRecord,
    FieldDescription,
    OutputBundle,
    ProcessingStep,
    SourceRecord,
    WarningEntry,
)


def _write_csv(path: Path, header: list[str], rows: list[list[str]]) -> Path:
    """写入 CSV 文件，返回文件路径。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)
    return path


def export_records_csv(records: list[DataRecord], output_path: Path) -> Path:
    """导出主数据 CSV — 每条记录包含来源信息和数据字段。

    列：source, accession, source_url, raw_file, doi, pmid, pmcid,
        page, table_number, supplementary_file, + 所有数据字段（取并集）。
    """
    base_cols = [
        "source", "accession", "source_url", "raw_file",
        "doi", "pmid", "pmcid", "page", "table_number", "supplementary_file",
    ]
    # 收集所有数据字段名（取并集，保持出现顺序）
    data_field_names: list[str] = []
    seen: set[str] = set()
    for r in records:
        for k in r.fields:
            if k not in seen:
                seen.add(k)
                data_field_names.append(k)

    header = base_cols + data_field_names
    rows: list[list[str]] = []
    for r in records:
        row = [
            r.source, r.accession, r.source_url, r.raw_file,
            r.doi or "", r.pmid or "", r.pmcid or "",
            r.page or "", r.table_number or "", r.supplementary_file or "",
        ]
        for k in data_field_names:
            v = r.fields.get(k)
            row.append("" if v is None else str(v))
        rows.append(row)

    return _write_csv(output_path, header, rows)


def export_source_list_csv(sources: list[SourceRecord], output_path: Path) -> Path:
    """导出来源清单 CSV。"""
    header = [
        "source", "accession", "source_url", "local_files",
        "checksum", "mime_type", "format_hint", "retrieved_at", "warnings",
    ]
    rows = [
        [
            s.source, s.accession, s.source_url,
            "; ".join(s.local_files),
            s.checksum or "", s.mime_type or "", s.format_hint or "",
            s.retrieved_at.isoformat(),
            "; ".join(s.warnings),
        ]
        for s in sources
    ]
    return _write_csv(output_path, header, rows)


def export_processing_log_csv(steps: list[ProcessingStep], output_path: Path) -> Path:
    """导出处理记录 CSV — 每步记录 Tool、参数和影响记录数。"""
    header = ["step", "tool", "params", "affected_count", "description", "timestamp"]
    rows = [
        [
            str(s.step), s.tool, str(s.params), str(s.affected_count),
            s.description, s.timestamp.isoformat(),
        ]
        for s in steps
    ]
    return _write_csv(output_path, header, rows)


def export_field_descriptions_csv(
    fields: list[FieldDescription], output_path: Path
) -> Path:
    """导出字段说明 CSV。"""
    header = ["name", "dtype", "description", "unit", "source", "example"]
    rows = [
        [f.name, f.dtype, f.description, f.unit or "", f.source or "", f.example or ""]
        for f in fields
    ]
    return _write_csv(output_path, header, rows)


def export_warnings_csv(warnings: list[WarningEntry], output_path: Path) -> Path:
    """导出 warnings CSV。"""
    header = ["severity", "message", "source", "context"]
    rows = [
        [w.severity, w.message, w.source or "", w.context or ""]
        for w in warnings
    ]
    return _write_csv(output_path, header, rows)


def export_bundle(bundle: OutputBundle, artifacts_dir: Path) -> dict[str, Path]:
    """导出完整 OutputBundle 到 artifacts 目录。

    返回各产物文件路径的字典。
    """
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "records": export_records_csv(bundle.records, artifacts_dir / "main_data.csv"),
        "sources": export_source_list_csv(bundle.sources, artifacts_dir / "source_list.csv"),
        "processing_log": export_processing_log_csv(
            bundle.processing_steps, artifacts_dir / "processing_log.csv"
        ),
        "field_descriptions": export_field_descriptions_csv(
            bundle.field_descriptions, artifacts_dir / "field_descriptions.csv"
        ),
        "warnings": export_warnings_csv(bundle.warnings, artifacts_dir / "warnings.csv"),
    }
    return paths
