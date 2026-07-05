"""CSV 导出脚本（BioMed QAgent Stage 6）。

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

接口：
    python scripts/export/to_csv.py --input cleaned.json --out data.csv

成功输出（stdout）：{"status":"ok","output":"data.csv","rows":N}
失败输出：{"status":"error","message":"..."}
"""
import csv
import os
import sys
from pathlib import Path

# 兼容直接执行与包内导入两种模式
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import (  # noqa: E402
    build_columns, emit_error, emit_ok, flatten_record, load_records, log_stderr,
)


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


def main():
    import argparse
    from _base import setup_cli
    parser = argparse.ArgumentParser(
        prog="to_csv",
        description="导出 cleaned DataRecord 列表为 CSV（含溯源列）",
    )
    parser.add_argument("--input", required=True,
                        help="输入 cleaned DataRecord JSON 文件或目录")
    parser.add_argument("--out", required=True, help="输出 CSV 文件路径")
    parser.add_argument("--task-id", default="", help="任务 ID（保留参数）")
    args = parser.parse_args()
    try:
        records = load_records(args.input)
        log_stderr(f"加载 {len(records)} 条记录")
        columns, rows = write_csv(records, args.out)
        log_stderr(f"CSV 写入 {rows} 行，{len(columns)} 列 → {args.out}")
        emit_ok(args.out, rows=rows, columns=len(columns))
    except Exception as e:
        emit_error(f"CSV 导出失败: {e}")


if __name__ == "__main__":
    main()
