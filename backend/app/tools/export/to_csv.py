"""CSV 导出工具（BioMed QAgent Stage 6）。

输入：cleaned DataRecord JSON 列表（数组 / 单对象 / {"records": [...]} 信封）
输出：CSV 文件

列顺序：
    record_id, task_id, [所有 fields 展平], source_name, source_doi,
    source_url, source_pmid, source_accession, extraction_method,
    extraction_confidence, quality_flags, created_at

特性：
- 使用 csv 标准库写入（无第三方依赖）
- quality_flags 是列表，join 为分号分隔字符串
- 缺失值用空字符串
- 字段列动态收集（保持首次出现顺序），适配多源异构记录

模块导入示例：
    from .export.to_csv import write_csv
    columns, rows = write_csv(records, "data.csv")
"""
import csv
import os

from ._base import build_columns, flatten_record, load_records


def write_csv(records, output_path):
    """把 DataRecord 列表写入 CSV。

    返回 (columns, rows_written)。
    """
    columns = build_columns(records)
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    rows = 0
    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns,
                                extrasaction="ignore",
                                restval="")
        writer.writeheader()
        for r in records:
            flat = flatten_record(r)
            # DictWriter 会自动处理缺失字段为 restval=""
            writer.writerow(flat)
            rows += 1
    return columns, rows
