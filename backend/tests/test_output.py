"""输出与来源追踪测试 — 验证 OutputBundle 模型和 CSV 导出。"""
from __future__ import annotations

import csv
from pathlib import Path

import pytest

from app.domain.output import (
    DataRecord,
    FieldDescription,
    OutputBundle,
    ProcessingStep,
    SourceRecord,
    WarningEntry,
)
from app.tools.export import (
    export_bundle,
    export_field_descriptions_csv,
    export_processing_log_csv,
    export_records_csv,
    export_source_list_csv,
    export_warnings_csv,
)


# ---------------------------------------------------------------------------
# 领域模型
# ---------------------------------------------------------------------------


def test_data_record_links_to_source_and_raw_file() -> None:
    """每条记录至少关联原始数据源和 raw 文件。"""
    r = DataRecord(
        source="geo",
        accession="GSE12345",
        source_url="https://www.ncbi.nlm.nih.gov/geo/GSE12345",
        raw_file="data/tasks/t1/raw/GSE12345_matrix.txt",
        fields={"gene": "TP53", "log2fc": 1.5},
    )
    assert r.source == "geo"
    assert r.accession == "GSE12345"
    assert r.raw_file.endswith("GSE12345_matrix.txt")
    assert r.doi is None
    assert r.fields["gene"] == "TP53"


def test_data_record_paper_tracking() -> None:
    """论文提取数据记录 DOI/PMID 和原始位置。"""
    r = DataRecord(
        source="pubmed",
        accession="PMID12345",
        source_url="https://pubmed.ncbi.nlm.nih.gov/12345",
        raw_file="data/tasks/t1/raw/paper.pdf",
        doi="10.1234/test",
        pmid="12345",
        page="5",
        table_number="Table 2",
        supplementary_file="supp_data1.csv",
        fields={"protein": "BRCA1"},
    )
    assert r.doi == "10.1234/test"
    assert r.pmid == "12345"
    assert r.table_number == "Table 2"


def test_output_bundle_add_warning() -> None:
    bundle = OutputBundle()
    assert bundle.warnings == []
    bundle.add_warning("error", "GEO 接口超时", source="search_geo")
    assert len(bundle.warnings) == 1
    assert bundle.warnings[0].severity == "error"
    assert bundle.warnings[0].source == "search_geo"


def test_output_bundle_add_processing_step_increments() -> None:
    bundle = OutputBundle()
    bundle.add_processing_step("parse_csv", {"path": "a.csv"}, 100)
    bundle.add_processing_step("clean_missing", {"strategy": "drop"}, 5)
    assert len(bundle.processing_steps) == 2
    assert bundle.processing_steps[0].step == 1
    assert bundle.processing_steps[1].step == 2
    assert bundle.processing_steps[0].affected_count == 100


# ---------------------------------------------------------------------------
# CSV 导出
# ---------------------------------------------------------------------------


def test_export_records_csv(tmp_path: Path) -> None:
    records = [
        DataRecord(
            source="geo", accession="GSE1", source_url="u1", raw_file="r1.txt",
            fields={"gene": "TP53", "log2fc": 1.5},
        ),
        DataRecord(
            source="geo", accession="GSE2", source_url="u2", raw_file="r2.txt",
            fields={"gene": "BRCA1", "log2fc": None},
        ),
    ]
    out = export_records_csv(records, tmp_path / "main_data.csv")
    assert out.exists()
    with open(out, encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = list(reader)
    assert "source" in header and "raw_file" in header
    assert "gene" in header and "log2fc" in header
    assert len(rows) == 2
    assert rows[0][0] == "geo"
    assert rows[1][0] == "geo"


def test_export_source_list_csv(tmp_path: Path) -> None:
    sources = [
        SourceRecord(
            source="geo", accession="GSE1", source_url="u1",
            local_files=["raw/a.txt", "raw/b.txt"],
            format_hint="series_matrix", warnings=["partial"],
        ),
    ]
    out = export_source_list_csv(sources, tmp_path / "sources.csv")
    assert out.exists()
    with open(out, encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        row = next(reader)
    assert "format_hint" in header
    assert "raw/a.txt; raw/b.txt" in row[3]


def test_export_processing_log_csv(tmp_path: Path) -> None:
    steps = [
        ProcessingStep(step=1, tool="parse_csv", params={"path": "a.csv"}, affected_count=100),
    ]
    out = export_processing_log_csv(steps, tmp_path / "log.csv")
    assert out.exists()
    with open(out, encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        row = next(reader)
    assert "tool" in header and "affected_count" in header
    assert row[1] == "parse_csv"
    assert row[3] == "100"


def test_export_field_descriptions_csv(tmp_path: Path) -> None:
    fields = [
        FieldDescription(
            name="log2fc", dtype="float", description="log2 fold change",
            unit="log2", source="LOG2FC", example="1.5",
        ),
    ]
    out = export_field_descriptions_csv(fields, tmp_path / "fields.csv")
    assert out.exists()
    with open(out, encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        row = next(reader)
    assert "unit" in header
    assert row[0] == "log2fc"
    assert row[3] == "log2"


def test_export_warnings_csv(tmp_path: Path) -> None:
    warnings = [
        WarningEntry(severity="warning", message="3 missing values", source="clean"),
    ]
    out = export_warnings_csv(warnings, tmp_path / "warnings.csv")
    assert out.exists()
    with open(out, encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        row = next(reader)
    assert "severity" in header
    assert row[0] == "warning"


def test_export_bundle_creates_all_files(tmp_path: Path) -> None:
    bundle = OutputBundle(
        records=[
            DataRecord(source="geo", accession="GSE1", source_url="u", raw_file="r", fields={"g": "TP53"}),
        ],
        sources=[
            SourceRecord(source="geo", accession="GSE1", source_url="u", local_files=["r"]),
        ],
        processing_steps=[
            ProcessingStep(step=1, tool="parse", params={}, affected_count=1),
        ],
        field_descriptions=[
            FieldDescription(name="g", dtype="string", description="gene"),
        ],
        warnings=[
            WarningEntry(severity="info", message="ok"),
        ],
    )
    paths = export_bundle(bundle, tmp_path / "artifacts")
    assert len(paths) == 5
    for name, path in paths.items():
        assert path.exists(), f"{name} CSV 未创建"
    assert (tmp_path / "artifacts" / "main_data.csv").exists()
    assert (tmp_path / "artifacts" / "source_list.csv").exists()
    assert (tmp_path / "artifacts" / "processing_log.csv").exists()
    assert (tmp_path / "artifacts" / "field_descriptions.csv").exists()
    assert (tmp_path / "artifacts" / "warnings.csv").exists()


def test_export_empty_bundle(tmp_path: Path) -> None:
    """空 bundle 导出不报错，只写 header 行。"""
    bundle = OutputBundle()
    paths = export_bundle(bundle, tmp_path / "artifacts")
    for path in paths.values():
        assert path.exists()
        with open(path, encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            header = next(reader)
            rows = list(reader)
        assert len(header) > 0
        assert len(rows) == 0
