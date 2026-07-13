"""跨数据集字段对齐与合并工具。

提供字段名规范化、多数据集字段对齐和垂向合并功能。
用于将来自不同来源的异构数据集统一为一致的列结构。

对应数据集成 / 元分析预处理工作流。
"""
from __future__ import annotations

import re
from typing import Any

from app.domain.processing import ParsedDataset

# ---------------------------------------------------------------------------
# 字段名规范化
# ---------------------------------------------------------------------------

# 常见生物学字段的标准化映射
_STANDARD_NAMES: dict[str, str] = {
    "gene_symbol": "gene_symbol",
    "geneid": "gene_id",
    "gene_id": "gene_id",
    "entrez_id": "gene_id",
    "entrez_gene_id": "gene_id",
    "probeset_id": "probe_id",
    "probe_id": "probe_id",
    "symbol": "gene_symbol",
    "logfc": "log2_fold_change",
    "log2foldchange": "log2_fold_change",
    "log2_fc": "log2_fold_change",
    "p_value": "p_value",
    "pvalue": "p_value",
    "p_val": "p_value",
    "padj": "adjusted_p_value",
    "adj_p_val": "adjusted_p_value",
    "fdr": "adjusted_p_value",
    "fold_change": "fold_change",
    "expression": "expression",
    "sample_id": "sample_id",
    "sample": "sample_id",
    "tissue": "tissue",
    "condition": "condition",
}


def normalize_field_names(field_names: list[str]) -> dict[str, str]:
    """标准化字段名。

    处理步骤：
    1. 去除首尾空白
    2. 转为小写
    3. 将空格、连字符、句点等特殊字符替换为下划线
    4. 将多个连续下划线合并为单个
    5. 尝试匹配已知的生物学标准名称

    Args:
        field_names: 原始字段名列表。

    Returns:
        映射字典 ``{original_name: normalized_name}``。
    """
    mapping: dict[str, str] = {}

    for name in field_names:
        # 步骤 1-2: strip + lowercase
        normalized = name.strip().lower()

        # 步骤 3: 特殊字符 → 下划线
        normalized = re.sub(r"[^a-z0-9]+", "_", normalized)

        # 步骤 4: 合并连续下划线
        normalized = re.sub(r"_+", "_", normalized)

        # 步骤 5: 去除首尾下划线
        normalized = normalized.strip("_")

        # 步骤 6: 尝试标准名称映射
        if normalized in _STANDARD_NAMES:
            normalized = _STANDARD_NAMES[normalized]

        mapping[name] = normalized

    return mapping


# ---------------------------------------------------------------------------
# 字段对齐
# ---------------------------------------------------------------------------


def _field_similarity(a: str, b: str) -> float:
    """计算两个规范化字段名的相似度。

    使用组合策略：
    1. 完全匹配 → 1.0
    2. 一个包含另一个 → 0.85
    3. 共享公共前缀（> 3 字符）→ 按比例
    4. 否则 → 0.0

    Args:
        a: 规范化字段名。
        b: 规范化字段名。

    Returns:
        0.0 到 1.0 之间的相似度分数。
    """
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.85

    # 公共前缀检测
    min_len = min(len(a), len(b))
    common_prefix = 0
    for i in range(min_len):
        if a[i] == b[i]:
            common_prefix += 1
        else:
            break

    if common_prefix >= 4:
        return common_prefix / max(len(a), len(b))
    elif common_prefix >= 3 and min_len <= 6:
        # 短字段名对中，3 字符公共前缀已足够显著
        return 0.7

    return 0.0


def align_fields(datasets: list[ParsedDataset]) -> dict[str, list[str]]:
    """跨多个数据集查找对齐字段。

    对每个数据集规范化字段名，然后跨数据集查找匹配字段。
    匹配策略基于规范化名称的相似度（>= 0.7 的分数视为匹配）。

    Args:
        datasets: 要对其的 ParsedDataset 列表。

    Returns:
        对齐映射：``{normalized_name: [original_name_per_dataset]}``。
        列表长度与 ``datasets`` 长度相同，每个位置是该数据集中的
        原始字段名，若无匹配则为空字符串。
    """
    if not datasets:
        return {}

    num_datasets = len(datasets)

    # 每数据集的规范化字段映射
    normal_maps: list[dict[str, str]] = []
    for ds in datasets:
        normal_maps.append(normalize_field_names(ds.field_names))

    # 收集所有规范化名称（去重并保持首次出现顺序）
    all_normalized: list[str] = []
    seen: set[str] = set()
    for nm in normal_maps:
        for normalized_name in nm.values():
            if normalized_name not in seen:
                seen.add(normalized_name)
                all_normalized.append(normalized_name)

    # 为每个规范化名称做跨数据集对齐
    aligned: dict[str, list[str]] = {}

    for norm_name in all_normalized:
        aligned[norm_name] = [""] * num_datasets

        for ds_idx, nm in enumerate(normal_maps):
            # 先精确匹配
            found = False
            for orig, norm in nm.items():
                if norm == norm_name:
                    aligned[norm_name][ds_idx] = orig
                    found = True
                    break

            # 未精确匹配 → 模糊匹配
            if not found:
                best_score = 0.0
                best_orig = ""
                for orig, norm in nm.items():
                    score = _field_similarity(norm_name, norm)
                    if score >= 0.7 and score > best_score:
                        best_score = score
                        best_orig = orig
                aligned[norm_name][ds_idx] = best_orig

    # 过滤掉所有数据集中都不存在的字段
    filtered: dict[str, list[str]] = {}
    for norm_name, originals in aligned.items():
        if any(orig != "" for orig in originals):
            filtered[norm_name] = originals

    return filtered


# ---------------------------------------------------------------------------
# 数据集合并
# ---------------------------------------------------------------------------

# 需要跳过的内部元数据字段
_META_FIELDS = frozenset({
    "_source",
    "_dataset_id",
    "_row_index",
})


def merge_datasets(
    datasets: list[ParsedDataset],
    field_mapping: dict[str, list[str]],
    output_name: str,
) -> ParsedDataset:
    """垂向合并多个对齐的数据集。

    根据字段对齐映射将多个数据集合并为一个。每个输出行通过 ``_source``
    字段标记来源数据集，重复行保留首次出现。

    Args:
        datasets: 要对齐合并的 ParsedDataset 列表。
        field_mapping: 对齐映射，格式为
            ``{normalized_name: [original_name_per_dataset]}``，
            通常由 ``align_fields()`` 生成。
        output_name: 合并后的数据集名称。

    Returns:
        合并后的 ParsedDataset，包含 ``_source`` 来源标记字段。
    """
    if not datasets:
        return ParsedDataset(
            dataset_id="empty_merge",
            source_file="",
            table_name=output_name,
            field_names=["_source"],
            field_types={"_source": "string"},
            rows=[],
            source_locator="merge",
            parser_name="alignment_merger",
            parser_version="0.1.0",
        )

    # 输出列：规范化名称 + _source
    output_fields = list(field_mapping.keys())
    output_fields.append("_source")

   # 构建每数据集的列映射: original_name → output_name
    ds_column_maps: list[dict[str, str]] = []
    for ds_idx, _ds in enumerate(datasets):  # noqa: B007
        col_map: dict[str, str] = {}
        for norm_name, originals in field_mapping.items():
            if ds_idx < len(originals) and originals[ds_idx]:
                col_map[originals[ds_idx]] = norm_name
        ds_column_maps.append(col_map)

    # 合并行，去重
    seen_rows: set[str] = set()
    merged_rows: list[dict[str, Any]] = []

    for ds_idx, ds in enumerate(datasets):
        col_map = ds_column_maps[ds_idx]
        for row in ds.rows:
            # 映射到输出列
            out_row: dict[str, Any] = {field: "" for field in output_fields}
            for orig_field, value in row.items():
                if orig_field in col_map:
                    out_row[col_map[orig_field]] = value

            out_row["_source"] = ds.dataset_id

            # 去重：用非 _source 字段生成指纹
            fingerprint_parts = tuple(
                str(out_row.get(f, "")) for f in output_fields if f != "_source"
            )
            fingerprint = repr(fingerprint_parts)
            if fingerprint not in seen_rows:
                seen_rows.add(fingerprint)
                merged_rows.append(out_row)

    # 推断字段类型（排除 _source）
    data_fields = [f for f in output_fields if f != "_source"]
    field_types = {}
    for field in data_fields:
        for row in merged_rows:
            val = row.get(field)
            if val is not None and str(val).strip():
                from app.tools.processing import _infer_type
                t = _infer_type(str(val))
                field_types[field] = "string" if t == "null" else t
                break
        if field not in field_types:
            field_types[field] = "string"
    field_types["_source"] = "string"

    return ParsedDataset(
        dataset_id=output_name,
        source_file=",".join(ds.source_file for ds in datasets),
        table_name=output_name,
        field_names=output_fields,
        field_types=field_types,
        rows=merged_rows,
        source_locator="merge",
        parser_name="alignment_merger",
        parser_version="0.1.0",
    )
