"""json_to_excel.py — DataRecord JSON 转 Excel。

输入：DataRecord JSON 列表（裸数组 / 单对象 / {"records": [...]} 信封）
输出：.xlsx 文件（单 sheet，默认名为 "Data"）

用 openpyxl 写入（沙箱中可 pip install openpyxl），表头加粗，展平 fields 字典。
列顺序：record_id, [fields 展平列（按首次出现顺序）], source_name,
        source_doi, source_url, extraction_confidence

执行示例：
  python scripts/io/json_to_excel.py --input records.json --out data.xlsx --sheet "Data"
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import setup_cli, load_records, emit_ok, emit_error


def _flatten(d, prefix=""):
    """展平嵌套 dict 到顶层 key（用 . 连接层级）。"""
    out = {}
    for k, v in (d or {}).items():
        key = f"{prefix}.{k}" if prefix else str(k)
        if isinstance(v, dict):
            out.update(_flatten(v, key))
        else:
            out[key] = v
    return out


def convert(records, output_path, sheet_name):
    """将 DataRecord 列表写入 Excel，返回记录数。"""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font
    except ImportError:
        raise ImportError("openpyxl 未安装，请在沙箱中执行 pip install openpyxl")
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
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name
    ws.append(header)
    # 表头加粗
    for c in ws[1]:
        c.font = Font(bold=True)
    for r, ff in zip(records, flat_rows):
        src = r.get("source_ref", {}) or {}
        row = [r.get("record_id", "")]
        for col in field_cols:
            v = ff.get(col)
            row.append(v if v is not None else "")
        row.append(src.get("source_name", ""))
        row.append(src.get("source_doi", ""))
        row.append(src.get("source_url", ""))
        row.append(r.get("extraction_confidence", ""))
        ws.append(row)
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    wb.save(output_path)
    return len(records)


def main():
    parser = setup_cli("json_to_excel", "DataRecord JSON 转 Excel")
    parser.add_argument("--sheet", default="Data", help="输出工作表名（默认 Data）")
    args = parser.parse_args()
    try:
        records = load_records(args.input)
        count = convert(records, args.out, args.sheet)
        emit_ok(args.out, count)
    except Exception as e:
        emit_error(str(e))


if __name__ == "__main__":
    main()
