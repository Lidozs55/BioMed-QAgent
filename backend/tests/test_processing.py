"""Processing 工具测试 — 文件解析和数据清洗。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from app.domain.processing import ParsedDataset
from app.tools.cleaning import (
    check_field_types,
    clean_dataset,
    count_missing,
    detect_duplicates,
    normalize_date,
    normalize_strings,
)
from app.tools.processing import (
    identify_format,
    parse_csv,
    parse_file,
    parse_html_tables,
    parse_json,
)

# ---------------------------------------------------------------------------
# 格式识别
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("filename,expected", [
    ("data.csv", "csv"),
    ("data.tsv", "tsv"),
    ("data.json", "json"),
    ("data.jsonl", "jsonl"),
    ("page.html", "html"),
    ("page.htm", "html"),
    ("data.xlsx", "excel"),
    ("unknown.xyz", "unknown"),
])
def test_identify_format(filename: str, expected: str) -> None:
    assert identify_format(filename) == expected


# ---------------------------------------------------------------------------
# CSV / TSV 解析
# ---------------------------------------------------------------------------


def test_parse_csv(tmp_path: Path) -> None:
    f = tmp_path / "test.csv"
    f.write_text("gene,log2fc,pvalue\nTP53,1.5,0.01\nBRCA1,2.3,0.001\n", encoding="utf-8")

    ds = parse_csv(str(f))
    assert ds.dataset_id == "test"
    assert ds.field_names == ["gene", "log2fc", "pvalue"]
    assert ds.row_count == 2
    assert ds.rows[0]["gene"] == "TP53"
    assert ds.field_types["gene"] == "string"
    assert ds.field_types["log2fc"] == "float"


def test_parse_tsv(tmp_path: Path) -> None:
    f = tmp_path / "test.tsv"
    f.write_text("gene\tlog2fc\nTP53\t1.5\n", encoding="utf-8")

    ds = parse_csv(str(f))
    assert ds.field_names == ["gene", "log2fc"]
    assert ds.rows[0]["gene"] == "TP53"
    assert ds.rows[0]["log2fc"] == "1.5"


def test_parse_csv_with_custom_delimiter(tmp_path: Path) -> None:
    f = tmp_path / "test.txt"
    f.write_text("gene;log2fc\nTP53;1.5\n", encoding="utf-8")

    ds = parse_csv(str(f), delimiter=";")
    assert ds.field_names == ["gene", "log2fc"]


# ---------------------------------------------------------------------------
# JSON 解析
# ---------------------------------------------------------------------------


def test_parse_json_array(tmp_path: Path) -> None:
    f = tmp_path / "test.json"
    data = [{"gene": "TP53", "log2fc": 1.5}, {"gene": "BRCA1", "log2fc": 2.3}]
    f.write_text(json.dumps(data), encoding="utf-8")

    ds = parse_json(str(f))
    assert ds.row_count == 2
    assert ds.field_names == ["gene", "log2fc"]
    assert ds.rows[0]["gene"] == "TP53"


def test_parse_json_object(tmp_path: Path) -> None:
    f = tmp_path / "test.json"
    data = {"gene": "TP53", "log2fc": 1.5}
    f.write_text(json.dumps(data), encoding="utf-8")

    ds = parse_json(str(f))
    assert ds.row_count == 1
    assert ds.rows[0]["gene"] == "TP53"


# ---------------------------------------------------------------------------
# HTML 表格解析
# ---------------------------------------------------------------------------


def test_parse_html_tables(tmp_path: Path) -> None:
    f = tmp_path / "test.html"
    f.write_text(
        "<html><body>"
        "<table><tr><th>Gene</th><th>Log2FC</th></tr>"
        "<tr><td>TP53</td><td>1.5</td></tr>"
        "<tr><td>BRCA1</td><td>2.3</td></tr>"
        "</table>"
        "</body></html>",
        encoding="utf-8",
    )

    datasets = parse_html_tables(str(f))
    assert len(datasets) == 1
    ds = datasets[0]
    assert ds.field_names == ["Gene", "Log2FC"]
    assert ds.row_count == 2
    assert ds.rows[0]["Gene"] == "TP53"
    assert ds.dataset_id == "test_table1"


def test_parse_html_multiple_tables(tmp_path: Path) -> None:
    f = tmp_path / "multi.html"
    f.write_text(
        "<table><tr><th>A</th></tr><tr><td>1</td></tr></table>"
        "<table><tr><th>B</th></tr><tr><td>2</td></tr></table>",
        encoding="utf-8",
    )
    datasets = parse_html_tables(str(f))
    assert len(datasets) == 2
    assert datasets[0].field_names == ["A"]
    assert datasets[1].field_names == ["B"]


# ---------------------------------------------------------------------------
# 通用解析入口
# ---------------------------------------------------------------------------


def test_parse_file_csv(tmp_path: Path) -> None:
    f = tmp_path / "test.csv"
    f.write_text("a,b\n1,2\n", encoding="utf-8")
    ds = parse_file(str(f))
    assert isinstance(ds, ParsedDataset)
    assert ds.field_names == ["a", "b"]


def test_parse_file_html_returns_list(tmp_path: Path) -> None:
    f = tmp_path / "test.html"
    f.write_text(
        "<table><tr><th>A</th></tr><tr><td>1</td></tr></table>",
        encoding="utf-8",
    )
    result = parse_file(str(f))
    assert isinstance(result, list)


def test_parse_file_unsupported(tmp_path: Path) -> None:
    f = tmp_path / "test.xyz"
    f.write_text("data", encoding="utf-8")
    with pytest.raises(ValueError, match="不支持的文件格式"):
        parse_file(str(f))


# ---------------------------------------------------------------------------
# 数据清洗
# ---------------------------------------------------------------------------


def _make_dataset(rows: list[dict], fields: list[str], types: dict[str, str] | None = None) -> ParsedDataset:
    return ParsedDataset(
        dataset_id="test",
        source_file="test.csv",
        table_name="test",
        field_names=fields,
        field_types=types or {f: "string" for f in fields},
        rows=rows,
    )


def test_count_missing() -> None:
    ds = _make_dataset(
        [{"a": "1", "b": ""}, {"a": "", "b": "2"}, {"a": "3", "b": "4"}],
        ["a", "b"],
    )
    stats = count_missing(ds)
    assert stats["a"] == 1
    assert stats["b"] == 1


def test_detect_duplicates() -> None:
    ds = _make_dataset(
        [{"a": "1"}, {"a": "1"}, {"a": "2"}, {"a": "1"}],
        ["a"],
    )
    assert detect_duplicates(ds) == 2


def test_detect_duplicates_no_duplicates() -> None:
    ds = _make_dataset(
        [{"a": "1"}, {"a": "2"}, {"a": "3"}],
        ["a"],
    )
    assert detect_duplicates(ds) == 0


def test_check_field_types() -> None:
    ds = _make_dataset(
        [{"a": "1"}, {"a": "2"}, {"a": "hello"}],
        ["a"],
        {"a": "int"},
    )
    issues = check_field_types(ds)
    assert issues["a"] == 1


def test_normalize_date() -> None:
    assert normalize_date("2024-01-15") == "2024-01-15"
    assert normalize_date("2024/01/15") == "2024-01-15"
    assert normalize_date("15-01-2024") == "2024-01-15"
    assert normalize_date("not a date") is None


def test_normalize_strings() -> None:
    ds = _make_dataset(
        [{"a": "  hello  "}, {"a": "world"}],
        ["a"],
    )
    corrections = normalize_strings(ds)
    assert corrections["a"] == 1
    assert ds.rows[0]["a"] == "hello"


def test_clean_dataset_full() -> None:
    ds = _make_dataset(
        [
            {"a": "  1  ", "b": ""},
            {"a": "1", "b": "2"},
            {"a": "hello", "b": "3"},
        ],
        ["a", "b"],
        {"a": "int", "b": "int"},
    )
    report = clean_dataset(ds)

    assert report.missing_stats["b"] == 1
    assert report.duplicate_count == 0
    assert report.format_corrections["a"] == 1  # 第一行 "  1  " 被 strip
    assert report.type_issues["a"] == 1  # "hello" 不是 int
    assert len(report.rules_applied) > 0
    assert report.total_affected > 0
    # 不删除行
    assert ds.row_count == 3


def test_clean_dataset_no_issues() -> None:
    ds = _make_dataset(
        [{"a": "1", "b": "2"}, {"a": "3", "b": "4"}],
        ["a", "b"],
        {"a": "int", "b": "int"},
    )
    report = clean_dataset(ds)
    assert report.duplicate_count == 0
    assert sum(report.missing_stats.values()) == 0
    assert sum(report.type_issues.values()) == 0
    assert report.total_affected == 0
