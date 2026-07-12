"""PDB / mmCIF 结构文件解析器。

解析蛋白质数据库 (PDB) 格式和 mmCIF (macromolecular Crystallographic
Information File) 格式的结构文件，提取原子级元数据为表格数据。

对应生物信息学数据解析工具集。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app.domain.processing import ParsedDataset
from app.tools.processing import _infer_field_types

PARSER_NAME = "pdb_parser"
PARSER_VERSION = "0.1.0"

# PDB ATOM 记录的固定列宽定义（Fortran 格式）
# 列定义参考 PDB Format Guide v3.30
_PDB_ATOM_COLUMNS = [
    "atom_serial",    #  7-11   Atom serial number
    "atom_name",      # 13-16   Atom name
    "alt_loc",        # 17      Alternate location indicator
    "residue_name",   # 18-20   Residue name
    "chain_id",       # 22      Chain identifier
    "residue_seq",    # 23-26   Residue sequence number
    "insert_code",    # 27      Code for insertion of residues
    "x",              # 31-38   Orthogonal coordinates for X (Angstroms)
    "y",              # 39-46   Orthogonal coordinates for Y (Angstroms)
    "z",              # 47-54   Orthogonal coordinates for Z (Angstroms)
    "occupancy",      # 55-60   Occupancy
    "b_factor",       # 61-66   Temperature factor
    "element",        # 77-78   Element symbol
    "charge",         # 79-80   Charge on the atom
]


# ---------------------------------------------------------------------------
# PDB 解析
# ---------------------------------------------------------------------------


def parse_pdb(
    file_path: str,
    dataset_id: str | None = None,
) -> ParsedDataset:
    """解析 PDB 格式结构文件，提取 ATOM 记录行。

    解析 PDB 文件中的 ATOM / HETATM 记录，按固定列宽提取原子属性：
    序列号、原子名、残基名、链 ID、残基序号、坐标 (x, y, z)、
    占据率、温度因子、元素符号。

    Args:
        file_path: .pdb 文件路径。
        dataset_id: 数据集 ID。None 时使用文件名。

    Returns:
        包含原子记录的 ParsedDataset。
    """
    path = Path(file_path)
    ds_id = dataset_id or path.stem
    warnings: list[str] = []

    field_names = [
        "atom_serial", "atom_name", "residue_name", "chain_id",
        "residue_seq", "x", "y", "z", "occupancy", "b_factor", "element",
    ]
    rows: list[dict[str, Any]] = []

    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            if line.startswith("ATOM  ") or line.startswith("HETATM"):
                try:
                    # 固定列宽解析，对齐到字段边界
                    atom_serial = line[6:11].strip()
                    atom_name = line[12:16].strip()
                    residue_name = line[17:20].strip()
                    chain_id = line[21:22].strip()
                    residue_seq = line[22:26].strip()
                    x = line[30:38].strip()
                    y = line[38:46].strip()
                    z = line[46:54].strip()
                    occupancy = line[54:60].strip()
                    b_factor = line[60:66].strip()
                    element = line[76:78].strip()

                    row: dict[str, Any] = {
                        "atom_serial": atom_serial,
                        "atom_name": atom_name,
                        "residue_name": residue_name,
                        "chain_id": chain_id if chain_id else "",
                        "residue_seq": residue_seq,
                        "x": x,
                        "y": y,
                        "z": z,
                        "occupancy": occupancy,
                        "b_factor": b_factor,
                        "element": element if element else "",
                    }
                    rows.append(row)
                except Exception:
                    warnings.append(f"无法解析行: {line[:80].rstrip()}...")
                    continue

    if not rows:
        warnings.append("未找到 ATOM 或 HETATM 记录行")

    field_types = _infer_field_types(field_names, rows)

    return ParsedDataset(
        dataset_id=ds_id,
        source_file=str(path),
        table_name=path.name,
        field_names=field_names,
        field_types=field_types,
        rows=rows,
        source_locator=f"{path.name}",
        parser_name=PARSER_NAME,
        parser_version=PARSER_VERSION,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# mmCIF 解析
# ---------------------------------------------------------------------------


def _parse_mmcif_atom_site_loop(file_path: str) -> tuple[list[str], list[dict[str, Any]]]:
    """从 mmCIF 文件的 _atom_site 循环中提取数据。

    mmCIF _atom_site 块结构：
    - 数据项以 ``_atom_site.`` 开头，定义列名
    - 循环体内的每一行是一个原子的数据值，按空白分隔

    Args:
        file_path: .cif 文件路径。

    Returns:
        (列名列表, 行数据列表) 元组。
    """
    with open(file_path, "r", encoding="utf-8-sig") as f:
        lines = f.readlines()

    # 查找 _atom_site 循环段
    in_atom_site = False
    in_loop = False
    column_defs: list[str] = []
    data_lines: list[str] = []

    for line in lines:
        stripped = line.strip()

        if stripped.startswith("_atom_site."):
            if not in_loop:
                in_atom_site = True
                in_loop = False
            if in_atom_site and not in_loop:
                # 收集列定义
                col_name = stripped[len("_atom_site."):]
                column_defs.append(col_name)

        elif stripped == "loop_" and in_atom_site:
            in_loop = True
            continue

        elif in_loop and in_atom_site:
            # 如果遇到下一个数据块标记，退出
            if stripped.startswith("_") or stripped.startswith("loop_") or stripped.startswith("#"):
                if column_defs and data_lines:
                    break
                continue

            if stripped and not stripped.startswith("#") and not stripped.startswith(";"):
                data_lines.append(stripped)

    # 映射到展示用字段名
    field_mapping = {
        "label_atom_id": "label_atom_id",
        "label_comp_id": "label_comp_id",
        "label_asym_id": "label_asym_id",
        "label_seq_id": "label_seq_id",
        "Cartn_x": "Cartn_x",
        "Cartn_y": "Cartn_y",
        "Cartn_z": "Cartn_z",
        "B_iso_or_equiv": "B_iso_or_equiv",
        "type_symbol": "type_symbol",
    }

    # 过滤只保留目标字段
    selected_columns: list[str] = []
    selected_indices: list[int] = []
    for i, col_def in enumerate(column_defs):
        col_lower = col_def.lower()
        for target_key, target_val in field_mapping.items():
            if target_key.lower() == col_lower or col_lower.startswith(target_key.lower()):
                if target_val not in selected_columns:
                    selected_columns.append(target_val)
                    selected_indices.append(i)
                break

    # 如果没有匹配到目标字段，使用全部字段
    if not selected_columns:
        selected_columns = column_defs
        selected_indices = list(range(len(column_defs)))

    # 解析数据行
    rows: list[dict[str, Any]] = []
    for data_line in data_lines:
        tokens = data_line.split()
        if len(tokens) >= max(selected_indices, default=-1) + 1:
            row: dict[str, Any] = {}
            for col_name, idx in zip(selected_columns, selected_indices):
                row[col_name] = tokens[idx] if idx < len(tokens) else ""
            rows.append(row)

    return selected_columns, rows


def parse_mmcif(
    file_path: str,
    dataset_id: str | None = None,
) -> ParsedDataset:
    """解析 mmCIF 格式结构文件。

    从 .cif 文件中提取 ``_atom_site.`` 数据循环，包括原子标识、
    三维坐标 (Cartn_x/y/z)、温度因子 (B_iso_or_equiv) 和元素类型。

    Args:
        file_path: .cif 文件路径。
        dataset_id: 数据集 ID。None 时使用文件名。

    Returns:
        包含原子站点数据的 ParsedDataset。
    """
    path = Path(file_path)
    ds_id = dataset_id or path.stem
    warnings: list[str] = []

    columns, rows = _parse_mmcif_atom_site_loop(str(path))

    if not columns:
        warnings.append("未找到 _atom_site 数据循环")

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
