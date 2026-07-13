"""GEO Series Matrix / SOFT 格式解析器。

解析 NCBI GEO (Gene Expression Omnibus) 的 Series Matrix 文件和 SOFT 格式文件，
转换为统一的 ParsedDataset 对象。

对应数据解析工具集，用于处理基因表达矩阵和注释数据。
"""
from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Any

from app.domain.processing import ParsedDataset
from app.tools.processing import _infer_field_types

PARSER_NAME = "geo_parser"
PARSER_VERSION = "0.1.0"


# ---------------------------------------------------------------------------
# GEO Series Matrix 解析
# ---------------------------------------------------------------------------

def parse_geo_matrix(
    file_path: str,
    dataset_id: str | None = None,
) -> ParsedDataset:
    """解析 GEO Series Matrix 文件。

    Series Matrix 文件格式：
    - 以 ``!`` 开头的行为元数据注释行
    - 第一个非注释行为列头（制表符分隔）
    - 后续行为数据行（制表符分隔）

    Args:
        file_path: Series Matrix 文件路径。
        dataset_id: 数据集 ID。None 时使用文件名。

    Returns:
        包含解析后数据的 ParsedDataset。
    """
    path = Path(file_path)
    ds_id = dataset_id or path.stem
    warnings: list[str] = []

    header: list[str] = []
    data_lines: list[str] = []

    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            stripped = line.rstrip("\n\r")
            if not stripped:
                continue
            if stripped.startswith("!"):
                continue
            if not header:
                header = stripped.split("\t")
            else:
                data_lines.append(stripped)

    if not header:
        warnings.append("未找到列头行 — 文件可能为空或仅包含注释")
        return ParsedDataset(
            dataset_id=ds_id,
            source_file=str(path),
            table_name=path.name,
            field_names=[],
            field_types={},
            rows=[],
            source_locator=f"{path.name}",
            parser_name=PARSER_NAME,
            parser_version=PARSER_VERSION,
            warnings=warnings,
        )

    reader = csv.DictReader(
        io.StringIO("\n".join(data_lines)),
        delimiter="\t",
        fieldnames=header,
    )
    rows: list[dict[str, Any]] = list(reader)

    field_types = _infer_field_types(header, rows)

    return ParsedDataset(
        dataset_id=ds_id,
        source_file=str(path),
        table_name=path.name,
        field_names=list(header),
        field_types=field_types,
        rows=rows,
        source_locator=f"{path.name}",
        parser_name=PARSER_NAME,
        parser_version=PARSER_VERSION,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# GEO SOFT 格式解析
# ---------------------------------------------------------------------------

def _extract_soft_header(lines: list[str], marker: str) -> list[str]:
    """从 SOFT 格式的 table_begin/table_end 块中提取列头。

    SOFT 格式的列头定义在 ``!dataset_table_begin`` 和
    ``!dataset_table_end``（或对应的 sample 标记）之间，
    每行是一个单独的 ``!column_name`` 声明。

    Args:
        lines: table_begin 和 table_end 之间的行。
        marker: 列头标记前缀（如 ``!dataset_table_begin``）。

    Returns:
        提取到的列名列表。
    """
    columns: list[str] = []
    for line in lines:
        if line.startswith("#"):
            # 列头行格式: #column_name = Description
            col_name = line[1:].split("=")[0].strip()
            columns.append(col_name)
        elif line.startswith("!"):
            # 备选格式: !column_name
            col_name = line[1:].split("=")[0].strip()
            columns.append(col_name)
    return columns


def parse_geo_soft(
    file_path: str,
    dataset_id: str | None = None,
) -> ParsedDataset:
    """解析 GEO SOFT 格式文件。

    SOFT 格式结构：
    - 元数据行以 ``^`` ``!`` ``#`` 开头
    - ``^DATASET`` / ``^SAMPLE`` 标记表区段的开始
    - ``!dataset_table_begin`` / ``!dataset_table_end`` 定义表格列头
    - 列头之间的行为制表符分隔的数据

    Args:
        file_path: SOFT 格式文件路径。
        dataset_id: 数据集 ID。None 时使用文件名。

    Returns:
        包含解析后数据的 ParsedDataset。
    """
    path = Path(file_path)
    ds_id = dataset_id or path.stem
    warnings: list[str] = []

    with open(path, encoding="utf-8-sig") as f:
        file_lines = f.readlines()

    # 查找第一个 table 块
    in_table = False
    table_lines: list[str] = []
    columns: list[str] = []

    for line in file_lines:
        stripped = line.rstrip("\n\r")

        # 检测 table_begin
        if stripped.startswith("!dataset_table_begin") or \
            stripped.startswith("!sample_table_begin"):
            in_table = True
            table_lines = []
            continue

        # 检测 table_end — 提取列头并退出
        if stripped.startswith("!dataset_table_end") or \
            stripped.startswith("!sample_table_end"):
            if table_lines:
                columns = _extract_soft_header(table_lines, stripped)
            in_table = False
            break

        if in_table:
            table_lines.append(stripped)

    if not columns:
        warnings.append("未找到 !dataset_table_begin/!sample_table_begin 块 — 回退到 Matrix 模式")
        # 回退：尝试按 Matrix 方式解析整个文件
        header: list[str] = []
        data_lines: list[str] = []
        for line in file_lines:
            stripped = line.rstrip("\n\r")
            if not stripped:
                continue
            if stripped.startswith("!") or stripped.startswith("^") or stripped.startswith("#"):
                continue
            if not header:
                header = stripped.split("\t")
            elif header:
                data_lines.append(stripped)

        if not header:
            warnings.append("回退解析也未能找到列头")
            return ParsedDataset(
                dataset_id=ds_id,
                source_file=str(path),
                table_name=path.name,
                field_names=[],
                field_types={},
                rows=[],
                source_locator=f"{path.name}",
                parser_name=PARSER_NAME,
                parser_version=PARSER_VERSION,
                warnings=warnings,
            )

        reader = csv.DictReader(
            io.StringIO("\n".join(data_lines)),
            delimiter="\t",
            fieldnames=header,
        )
        rows: list[dict[str, Any]] = list(reader)
        columns = header

    else:
        # 在 table 块之后查找数据行（以 ^DATASET 或 ^SAMPLE 开头的制表符分隔行）
        data_rows: list[str] = []
        capture_data = False
        for line in file_lines:
            stripped = line.rstrip("\n\r")
            if stripped.startswith("!dataset_table_end") or \
            stripped.startswith("!sample_table_end"):
                capture_data = True
                continue
            if capture_data:
                if stripped.startswith("!") or stripped.startswith("^"):
                    if stripped.startswith("!"):
                        continue
                    break
                if stripped.strip():
                    data_rows.append(stripped)

        reader = csv.DictReader(
            io.StringIO("\n".join(data_rows)),
            delimiter="\t",
            fieldnames=columns,
        )
        rows = list(reader)

    field_types = _infer_field_types(columns, rows)

    return ParsedDataset(
        dataset_id=ds_id,
        source_file=str(path),
        table_name=path.name,
        field_names=list(columns),
        field_types=field_types,
        rows=rows,
        source_locator=f"{path.name}",
        parser_name=PARSER_NAME,
        parser_version=PARSER_VERSION,
        warnings=warnings,
    )
