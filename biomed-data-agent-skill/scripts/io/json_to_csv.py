"""json_to_csv.py — DataRecord JSON 转 CSV。

输入：DataRecord JSON 列表（裸数组 / 单对象 / {"records": [...]} 信封）
输出：CSV 文件（UTF-8）

处理：
  - 展平 fields 字典到顶层列（嵌套 dict 用 . 连接 key）
  - 保留 source_ref 的关键字段（source_name, source_doi, source_url）
  - 列顺序：record_id, [fields 展平列（按首次出现顺序）], source_name,
            source_doi, source_url, extraction_confidence

执行示例：
  python scripts/io/json_to_csv.py --input records.json --out data.csv
"""
import csv
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import setup_cli, load_records, emit_ok, emit_error


def _flatten(d, prefix=""):
    """展平嵌套 dict 到顶层 key（用 . 连接层级）。list/dict 原样保留后转字符串。"""
    out = {}
    for k, v in (d or {}).items():
        key = f"{prefix}.{k}" if prefix else str(k)
        if isinstance(v, dict):
            out.update(_flatten(v, key))
        else:
            out[key] = v
    return out


def _cell(v):
    """将任意值转为 CSV 单元格字符串；list/dict 转 JSON 字符串。"""
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        import json
        return json.dumps(v, ensure_ascii=False, default=str)
    return v


def convert(records, output_path):
    """将 DataRecord 列表写入 CSV，返回记录数。"""
    # 第一遍：收集所有 fields 列名（保持首次出现顺序）
    field_cols = []
    seen = set()
    flat_rows = []
    for r in records:
        ff = _flatten(r.get("fields", {}))
        for k in ff:
            if k not in seen:
                seen.add(k)
                field_cols.append(k)
        flat_rows.append(ff)
    tail_cols = ["source_name", "source_doi", "source_url", "extraction_confidence"]
    header = ["record_id"] + field_cols + tail_cols
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        for r, ff in zip(records, flat_rows):
            src = r.get("source_ref", {}) or {}
            row = [r.get("record_id", "")]
            row.extend(_cell(ff.get(col)) for col in field_cols)
            row.append(src.get("source_name", ""))
            row.append(src.get("source_doi", ""))
            row.append(src.get("source_url", ""))
            row.append(r.get("extraction_confidence", ""))
            writer.writerow(row)
    return len(records)


def main():
    parser = setup_cli("json_to_csv", "DataRecord JSON 转 CSV")
    args = parser.parse_args()
    try:
        records = load_records(args.input)
        count = convert(records, args.out)
        emit_ok(args.out, count)
    except Exception as e:
        emit_error(str(e))


if __name__ == "__main__":
    main()
