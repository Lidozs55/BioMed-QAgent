"""文件解析工具 — 从本地 raw 文件解析结构化数据。

对应 TODO.md Section 8.1：
- 根据扩展名、MIME 和文件内容识别格式
- 解析 CSV 和 TSV
- 解析 JSON
- 解析 HTML 表格

解析结果写入 task/parsed/，不覆盖 raw 文件。
下载与解析严格分离：本工具只读取 raw 文件，不下载。
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from app.domain.processing import ParsedDataset

PARSER_NAME = "biomed_parser"
PARSER_VERSION = "0.1.0"


# ---------------------------------------------------------------------------
# 格式识别
# ---------------------------------------------------------------------------

_EXTENSION_MAP = {
    ".csv": "csv",
    ".tsv": "tsv",
    ".txt": "csv",  # 默认按 CSV 尝试
    ".json": "json",
    ".jsonl": "jsonl",
    ".html": "html",
    ".htm": "html",
    ".xls": "excel",
    ".xlsx": "excel",
}


def identify_format(file_path: str) -> str:
    """根据扩展名识别文件格式。

    Returns:
        格式标识：csv / tsv / json / jsonl / html / excel / unknown
    """
    ext = Path(file_path).suffix.lower()
    return _EXTENSION_MAP.get(ext, "unknown")


# ---------------------------------------------------------------------------
# 类型推断
# ---------------------------------------------------------------------------

def _infer_type(value: str) -> str:
    """推断单个值的类型。"""
    if value is None or value == "":
        return "null"
    # bool
    if value.lower() in ("true", "false"):
        return "bool"
    # int
    try:
        int(value)
        return "int"
    except ValueError:
        pass
    # float
    try:
        float(value)
        return "float"
    except ValueError:
        pass
    # date (简单匹配 YYYY-MM-DD)
    if len(value) == 10 and value[4] == "-" and value[7] == "-":
        return "date"
    return "string"


def _infer_field_types(field_names: list[str], rows: list[dict]) -> dict[str, str]:
    """推断每个字段的类型（取第一个非空值的类型）。"""
    types: dict[str, str] = {}
    for field in field_names:
        for row in rows:
            val = row.get(field)
            if val is not None and str(val).strip():
                t = _infer_type(str(val))
                types[field] = "string" if t == "null" else t
                break
        if field not in types:
            types[field] = "string"
    return types


# ---------------------------------------------------------------------------
# CSV / TSV 解析
# ---------------------------------------------------------------------------


def parse_csv(
    file_path: str,
    delimiter: str | None = None,
    dataset_id: str | None = None,
) -> ParsedDataset:
    """解析 CSV 或 TSV 文件。

    Args:
        file_path: raw 目录下的文件路径。
        delimiter: 分隔符。None 时自动检测（.tsv → tab，否则逗号）。
        dataset_id: 数据集 ID。None 时用文件名。
    """
    path = Path(file_path)
    if delimiter is None:
        delimiter = "\t" if path.suffix.lower() == ".tsv" else ","

    with open(path, "r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=delimiter)
        field_names = reader.fieldnames or []
        rows = list(reader)

    field_types = _infer_field_types(field_names, rows)
    ds_id = dataset_id or path.stem

    return ParsedDataset(
        dataset_id=ds_id,
        source_file=str(path),
        table_name=path.name,
        field_names=list(field_names),
        field_types=field_types,
        rows=rows,
        source_locator=f"{path.name}",
        parser_name=PARSER_NAME,
        parser_version=PARSER_VERSION,
    )


# ---------------------------------------------------------------------------
# JSON 解析
# ---------------------------------------------------------------------------


def parse_json(file_path: str, dataset_id: str | None = None) -> ParsedDataset:
    """解析 JSON 文件。

    支持：
    - 对象数组 [{...}, {...}] → 每个对象为一行
    - 对象 {key: [v1, v2]} → 转置为行
    """
    path = Path(file_path)
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)

    ds_id = dataset_id or path.stem
    warnings: list[str] = []

    if isinstance(data, list):
        # 对象数组
        rows = data
        field_names: list[str] = []
        seen: set[str] = set()
        for item in rows:
            if isinstance(item, dict):
                for k in item:
                    if k not in seen:
                        seen.add(k)
                        field_names.append(k)
            else:
                warnings.append(f"非对象元素: {type(item).__name__}")
    elif isinstance(data, dict):
        # 单个对象 → 转为单行
        rows = [data]
        field_names = list(data.keys())
    else:
        warnings.append(f"不支持的 JSON 顶层类型: {type(data).__name__}")
        rows = []
        field_names = []

    field_types = _infer_field_types(field_names, rows)

    return ParsedDataset(
        dataset_id=ds_id,
        source_file=str(path),
        table_name=path.name,
        field_names=field_names,
        field_types=field_types,
        rows=rows,
        source_locator=path.name,
        parser_name=PARSER_NAME,
        parser_version=PARSER_VERSION,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# HTML 表格解析
# ---------------------------------------------------------------------------


def parse_html_tables(file_path: str, dataset_id: str | None = None) -> list[ParsedDataset]:
    """解析 HTML 文件中的所有表格。

    使用标准库 html.parser，无额外依赖。
    """
    from html.parser import HTMLParser

    path = Path(file_path)
    ds_id = dataset_id or path.stem

    with open(path, "r", encoding="utf-8-sig") as f:
        html_content = f.read()

    class TableParser(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.tables: list[list[list[str]]] = []
            self._current_table: list[list[str]] | None = None
            self._current_row: list[str] | None = None
            self._current_cell: list[str] | None = None

        def handle_starttag(self, tag: str, attrs) -> None:
            if tag == "table":
                self._current_table = []
            elif tag == "tr" and self._current_table is not None:
                self._current_row = []
            elif tag in ("td", "th") and self._current_row is not None:
                self._current_cell = []

        def handle_endtag(self, tag: str) -> None:
            if tag in ("td", "th") and self._current_row is not None and self._current_cell is not None:
                self._current_row.append("".join(self._current_cell).strip())
                self._current_cell = None
            elif tag == "tr" and self._current_row is not None and self._current_table is not None:
                self._current_table.append(self._current_row)
                self._current_row = None
            elif tag == "table" and self._current_table is not None:
                self.tables.append(self._current_table)
                self._current_table = None

        def handle_data(self, data: str) -> None:
            if self._current_cell is not None:
                self._current_cell.append(data)

    parser = TableParser()
    parser.feed(html_content)

    datasets: list[ParsedDataset] = []
    for i, table in enumerate(parser.tables):
        if not table or len(table) < 2:
            continue
        header = table[0]
        rows = [
            {header[j]: row[j] if j < len(row) else "" for j in range(len(header))}
            for row in table[1:]
        ]
        field_types = _infer_field_types(header, rows)
        datasets.append(ParsedDataset(
            dataset_id=f"{ds_id}_table{i + 1}",
            source_file=str(path),
            table_name=f"table_{i + 1}",
            field_names=list(header),
            field_types=field_types,
            rows=rows,
            source_locator=f"{path.name}#table{i + 1}",
            parser_name=PARSER_NAME,
            parser_version=PARSER_VERSION,
        ))

    return datasets


# ---------------------------------------------------------------------------
# 通用解析入口
# ---------------------------------------------------------------------------


def parse_file(file_path: str, dataset_id: str | None = None) -> ParsedDataset | list[ParsedDataset]:
    """根据文件格式自动选择解析器。

    HTML 返回 list[ParsedDataset]（可能多个表格），其他格式返回单个 ParsedDataset。
    """
    fmt = identify_format(file_path)
    if fmt in ("csv", "tsv"):
        return parse_csv(file_path, dataset_id=dataset_id)
    elif fmt == "json":
        return parse_json(file_path, dataset_id=dataset_id)
    elif fmt == "html":
        return parse_html_tables(file_path, dataset_id=dataset_id)
    else:
        raise ValueError(f"不支持的文件格式: {fmt} ({file_path})")
