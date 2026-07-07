"""geo_soft.py — GEO SOFT 格式解析器。

用途：把 NCBI GEO SOFT 格式文件（.soft / .soft.gz）解析成 DataRecord 列表。

输入格式：
    GEO SOFT 文本，包含三类 entity，行首标记：
      ^SERIES / ^SAMPLE / ^PLATFORM      —— entity 起始
      !Series_title / !Sample_title ...  —— 元数据（! 开头）
      #ID_REF\\tVALUE ...                 —— 数据表表头（# 开头）
      1007_s_at\\t10.5                    —— 数据表行（无前缀）
    支持 gzip 压缩（.soft.gz）。

输出格式：
    每个 Sample 一个 record，fields 含：
      sample_id (GSM...), title, source, characteristics (list),
      platform, expression_values (dict: 基因/探针 -> 数值), entity_type。

示例：
    from .geo_soft import GeoSoftParser
    parser = GeoSoftParser()
    records = parser.parse("GSE12345.family.soft.gz")

依赖：仅标准库（gzip / io）。
"""
import gzip
import io

from ._base import BaseParser, make_record


class GeoSoftParser(BaseParser):
    """纯 Python 实现的 GEO SOFT 解析器，不依赖 GEOparse。"""

    source_name = "geo"

    def _open(self, file_path):
        """打开文件，自动处理 gzip 压缩，返回文本流。"""
        if file_path.lower().endswith((".gz", ".soft.gz")):
            return io.TextIOWrapper(
                gzip.open(file_path, "rb"), encoding="utf-8-sig", errors="replace")
        return open(file_path, "r", encoding="utf-8-sig", errors="replace")

    def parse(self, file_path):
        records = []
        cur_type = None        # series / sample / platform
        cur_id = None
        meta = {}
        expression_values = {}
        table_header = None
        in_table = False

        def flush():
            """把当前累积的 entity 输出成 record（仅 sample 输出）。"""
            nonlocal meta, expression_values, cur_type, cur_id
            if cur_type == "sample" and cur_id:
                fields = {
                    "sample_id": cur_id,
                    "title": meta.get("title", ""),
                    "source": meta.get("source_name", ""),
                    "characteristics": meta.get("characteristics", []),
                    "platform": meta.get("platform_id", ""),
                    "expression_values": expression_values,
                    "entity_type": "Sample",
                }
                records.append(make_record(
                    task_id="", source_name=self.source_name,
                    fields=fields, file_path=file_path,
                    confidence=0.9, method="table",
                    accession=cur_id, source_type="file"))
            meta = {}
            expression_values = {}

        with self._open(file_path) as f:
            for line in f:
                line = line.rstrip("\n").rstrip("\r")
                if not line:
                    continue
                # entity 起始：^SERIES=GSE12345 / ^SAMPLE=GSM123
                if line.startswith("^"):
                    flush()
                    parts = line[1:].split("=", 1)
                    if len(parts) == 2:
                        cur_type = parts[0].strip().lower()
                        cur_id = parts[1].strip()
                    in_table = False
                    table_header = None
                    continue
                # 元数据或表格边界
                if line.startswith("!"):
                    key = line[1:]
                    low = key.lower()
                    if "table_begin" in low:
                        in_table = True
                        table_header = None
                        continue
                    if "table_end" in low:
                        in_table = False
                        table_header = None
                        continue
                    if "=" in key:
                        k, v = key.split("=", 1)
                        k = k.strip().lower()
                        v = v.strip()
                        if cur_type == "sample":
                            if k == "sample_title":
                                meta["title"] = v
                            elif k == "sample_source_name_ch1":
                                meta.setdefault("source_name", v)
                            elif k == "sample_characteristics_ch1":
                                meta.setdefault("characteristics", []).append(v)
                            elif k == "sample_platform_id":
                                meta["platform_id"] = v
                        elif cur_type == "series" and k == "series_title":
                            meta["title"] = v
                    continue
                # 表头行（# 开头）
                if line.startswith("#"):
                    if in_table:
                        table_header = [h.strip() for h in line[1:].split("\t")]
                    continue
                # 数据表行
                if in_table and table_header:
                    cols = line.split("\t")
                    if len(cols) >= 2:
                        gene_id = cols[0].strip()
                        val = cols[1].strip()
                        if gene_id and gene_id.upper() != "ID_REF":
                            try:
                                val = float(val)
                            except ValueError:
                                pass
                            expression_values[gene_id] = val
        flush()
        return records
