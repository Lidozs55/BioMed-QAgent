#!/usr/bin/env python3
"""pdf_table_parser.py — PDF 表格提取器。

用途：从 PDF 文件中提取表格，并尝试抓取 Figure / Table caption。

输入格式：
    PDF 文件，可选 --pages 指定页码范围（如 '1-5,7'，默认全部）。

输出格式：
    每个表格一个 record，fields 含：
      page, table_index, headers (list), rows (list of lists),
      row_count, entity_type。
    extraction_method = "table"，extraction_confidence = 0.8（PDF 表格有噪声）。
    同时为每个 caption 行输出一个 entity_type="Caption" 的 record。

示例：
    python pdf_table_parser.py --input paper.pdf --pages 1-5 --out result.json

依赖：pdfplumber（已在 scripts/requirements.txt 中声明）。
失败时输出结构化错误 JSON，不 crash。
"""
import re
import sys

from _base import (BaseParser, make_record, setup_cli,
                   make_ok, make_error, write_output)

# 匹配 "Figure 1" / "Table 2" / "Fig. 3" 等 caption 行
CAPTION_RE = re.compile(r"^\s*(Figure|Fig\.|Table)\s+\d+", re.IGNORECASE)


def parse_pages_spec(spec):
    """解析 --pages 参数（'1-5,7,9-11'）为 1-based 页码集合。"""
    if not spec:
        return None
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            try:
                a, b = part.split("-", 1)
                pages.update(range(int(a), int(b) + 1))
            except ValueError:
                continue
        else:
            try:
                pages.add(int(part))
            except ValueError:
                continue
    return pages or None


class PdfTableParser(BaseParser):
    """基于 pdfplumber 的 PDF 表格 + caption 提取器。"""

    source_name = "pdf"

    def parse(self, file_path, pages_spec=None):
        try:
            import pdfplumber
        except ImportError as e:
            raise RuntimeError(
                f"缺少依赖 pdfplumber: {e}. 请先 pip install pdfplumber") from e

        target_pages = parse_pages_spec(pages_spec)
        records = []
        with pdfplumber.open(file_path) as pdf:
            for page_idx, page in enumerate(pdf.pages, start=1):
                if target_pages is not None and page_idx not in target_pages:
                    continue
                # 提取表格
                try:
                    tables = page.extract_tables() or []
                except Exception:
                    tables = []
                for tbl_idx, table in enumerate(tables):
                    if not table:
                        continue
                    headers = [str(c).strip() if c is not None else ""
                               for c in table[0]]
                    rows = []
                    for row in table[1:]:
                        rows.append([str(c).strip() if c is not None else ""
                                     for c in row])
                    fields = {
                        "page": page_idx,
                        "table_index": tbl_idx,
                        "headers": headers,
                        "rows": rows,
                        "row_count": len(rows),
                        "entity_type": "Table",
                    }
                    records.append(make_record(
                        task_id="", source_name=self.source_name,
                        fields=fields, file_path=file_path,
                        confidence=0.8, method="table",
                        accession=f"page_{page_idx}_table_{tbl_idx}",
                        source_type="pdf"))
                # 提取 caption
                try:
                    text = page.extract_text() or ""
                except Exception:
                    text = ""
                for line in text.splitlines():
                    if CAPTION_RE.match(line):
                        fields = {
                            "page": page_idx,
                            "caption": line.strip(),
                            "entity_type": "Caption",
                        }
                        records.append(make_record(
                            task_id="", source_name=self.source_name,
                            fields=fields, file_path=file_path,
                            confidence=0.7, method="text",
                            accession=f"page_{page_idx}_caption",
                            source_type="pdf"))
        return records


def main():
    parser = setup_cli("pdf_table_parser", "PDF 表格提取器")
    parser.add_argument("--pages", default=None,
                        help="页码范围，如 '1-5,7'，默认全部")
    args = parser.parse_args()
    try:
        p = PdfTableParser()
        records = p.parse(args.input, pages_spec=args.pages)
        for r in records:
            r["task_id"] = args.task_id
        write_output(make_ok(records), args.out)
    except Exception as e:
        write_output(make_error(f"PDF 解析失败: {e}"), args.out)
        sys.exit(1)


if __name__ == "__main__":
    main()
