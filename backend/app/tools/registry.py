"""工具注册表 — backend 原生模块函数的统一 facade。

设计原则：
- 无 subprocess、无 CLI 参数解析：每个方法直接调用 backend 内模块的领域函数
- 按类别组织：datasources / parsers / cleaners / analysis / export
- 统一返回 ToolResult（.success / .data / .error / .signals），保持 orchestrator 简洁
- 每个方法是薄封装：调用领域函数 + 异常包装为 ToolResult
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class ToolResult:
    """工具执行结果。

    字段：
    - success: 是否成功
    - data: 返回数据（通常为记录列表，或分析结果 dict）
    - error: 失败时的错误信息
    - signals: 非记录信号（如 requires_crawl），供 acquire 阶段识别
    """

    def __init__(self, success: bool, data=None, error: str = "",
                 signals: dict | None = None):
        self.success = success
        self.data = data
        self.error = error
        self.signals = signals or {}

    def __repr__(self):
        if self.success:
            n = len(self.data) if isinstance(self.data, list) else 1
            return f"ToolResult(ok, {n} records)"
        return f"ToolResult(fail: {self.error[:80]})"


class ToolRegistry:
    """工具注册表 — backend 原生模块函数的统一 facade。

    所有方法直接调用 backend/app/tools/ 下的模块函数，无 subprocess。
    """

    # ========== Datasources ==========

    # 数据源名 → 模块检索函数的惰性映射
    # 函数签名约定: (query, max_results, task_id) -> list[dict]
    # 例外: string/kegg/disgenet/tcmsp 有额外参数（由 run_datasource 适配）
    _DS_FUNC_CACHE: dict = {}

    @classmethod
    def _get_ds_func(cls, name: str):
        """惰性加载并缓存数据源检索函数。"""
        if name in cls._DS_FUNC_CACHE:
            return cls._DS_FUNC_CACHE[name]
        # 按需导入，避免启动时加载所有数据源模块
        mapping = {
            "pubmed":            ("app.tools.datasources.pubmed", "search_pubmed"),
            "openalex":          ("app.tools.datasources.openalex", "search_openalex"),
            "semantic_scholar":  ("app.tools.datasources.semantic_scholar", "search_s2"),
            "arxiv":             ("app.tools.datasources.arxiv", "search_arxiv"),
            "geo":               ("app.tools.datasources.geo", "search_geo"),
            "string":            ("app.tools.datasources.string", "search_string"),
            "kegg":              ("app.tools.datasources.kegg", "search_kegg"),
            "pdb":               ("app.tools.datasources.pdb", "search_pdb"),
            "tcmsp":             ("app.tools.datasources.tcmsp", "_query_tcmsp"),
            "ncbi":              ("app.tools.datasources.ncbi", "search_ncbi"),
            "clinicaltrials":    ("app.tools.datasources.clinicaltrials", "search_clinicaltrials"),
            "tcga":              ("app.tools.datasources.tcga", "search_tcga"),
            "drugbank":          ("app.tools.datasources.drugbank", "search_drugbank"),
            "disgenet":          ("app.tools.datasources.disgenet", "search_disgenet"),
            "pubchem":           ("app.tools.datasources.pubchem", "search_pubchem"),
        }
        spec = mapping.get(name)
        if spec is None:
            return None
        import importlib
        mod = importlib.import_module(spec[0])
        func = getattr(mod, spec[1])
        cls._DS_FUNC_CACHE[name] = func
        return func

    def run_datasource(self, name: str, query: str, max_results: int = 20,
                        task_id: str = "T0", **kwargs) -> ToolResult:
        """执行单个数据源检索。

        kwargs 适配各数据源的特殊参数：
        - string: species (int, 默认 9606)
        - kegg:   species (str, 默认 "hsa")
        - disgenet: mode ("gene"|"disease", 默认 "gene")
        - ncbi:   db (str, 默认 "gene")
        - tcga:   search_type (str, 默认 "gene")
        - tcmsp:  无额外参数（返回 None → requires_crawl 信号）
        """
        func = self._get_ds_func(name)
        if func is None:
            return ToolResult(False, error=f"未知数据源: {name}")
        try:
            if name == "string":
                records = func(query, kwargs.get("species", 9606), max_results, task_id)
            elif name == "kegg":
                records = func(query, kwargs.get("species", "hsa"), max_results, task_id)
            elif name == "disgenet":
                records = func(query, kwargs.get("mode", "gene"), max_results, task_id)
            elif name == "ncbi":
                records = func(query, kwargs.get("db", "gene"), max_results, task_id)
            elif name == "tcga":
                records = func(query, kwargs.get("search_type", "gene"), max_results, task_id)
            elif name == "tcmsp":
                # tcmsp 接口不可用时返回 None → 通知 acquire 阶段需爬虫
                form_data = {"herbName": query, "pageNum": "1",
                             "pageSize": str(max_results)}
                records = func(form_data, task_id, query)
                if records is None:
                    return ToolResult(True, data=[],
                                       signals={"status": "requires_crawl",
                                                "reason": "tcmsp 接口不可用"})
            else:
                records = func(query, max_results, task_id)
            return ToolResult(True, data=records or [])
        except Exception as e:
            logger.exception("数据源 %s 检索失败", name)
            return ToolResult(False, error=f"{name}: {e}")

    def run_datasources_parallel(self, sources: list[str], query: str,
                                  max_results: int = 20,
                                  task_id: str = "T0") -> dict[str, ToolResult]:
        """并行检索多个数据源（线程池，最多 5 个并发）。"""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        results: dict[str, ToolResult] = {}
        if not sources:
            return results
        with ThreadPoolExecutor(max_workers=min(len(sources), 5)) as pool:
            futures = {
                pool.submit(self.run_datasource, name, query, max_results, task_id): name
                for name in sources
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    results[name] = future.result(timeout=90)
                except Exception as e:
                    results[name] = ToolResult(False, error=str(e))
        return results

    # ========== Parsers ==========

    def parse_pdf_table(self, pdf_path, output_file=None) -> ToolResult:
        """解析 PDF 表格 + caption。

        Args:
            pdf_path: PDF 文件路径
            output_file: 可选，将解析结果写入 JSON 文件
        Returns:
            ToolResult.data = records 列表
        """
        try:
            from app.tools.parsers.pdf_table import PdfTableParser
            parser = PdfTableParser()
            records = parser.parse(str(pdf_path))
            if output_file and records:
                self._write_json(output_file, records)
            return ToolResult(True, data=records or [])
        except Exception as e:
            logger.exception("pdf_table 解析失败: %s", pdf_path)
            return ToolResult(False, error=f"pdf_table: {e}")

    def download_pdfs(self, records: list[dict], pdf_dir,
                       max_download: int = 5, task_id: str = "T0",
                       output_file=None) -> ToolResult:
        """从记录列表中筛出含 pdf_url 的记录，下载开放获取 PDF。

        Args:
            records: DataRecord 列表
            pdf_dir: PDF 保存目录
            max_download: 最大下载数
            task_id: 任务 ID
            output_file: 可选，将更新后的记录写入 JSON
        Returns:
            ToolResult.data = 更新后的 records 列表（含 local_pdf_path）
        """
        import tempfile
        try:
            from app.tools.parsers.pdf_download import run as dl_run
            # 写入临时 JSON 供 dl_run 读取（dl_run 接受文件路径）
            with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False, encoding="utf-8"
            ) as tf:
                json.dump(records, tf, ensure_ascii=False, default=str)
                tmp_path = tf.name
            try:
                result_records = dl_run(tmp_path, str(pdf_dir),
                                         max_download=max_download, task_id=task_id)
            finally:
                Path(tmp_path).unlink(missing_ok=True)
            if output_file and result_records:
                self._write_json(output_file, result_records)
            return ToolResult(True, data=result_records or [])
        except Exception as e:
            logger.exception("pdf_download 失败")
            return ToolResult(False, error=f"pdf_download: {e}")

    # ========== Cleaners ==========

    def align_fields(self, records: list[dict], dict_dir) -> ToolResult:
        """字段对齐 — 用 dictionaries/ 字典归一化字段名。

        Args:
            records: DataRecord 列表
            dict_dir: dictionaries/ 目录路径
        Returns:
            ToolResult.data = 对齐后的 records 列表
        """
        try:
            from app.tools.cleaners.field_aligner import load_dictionaries, align_records
            field_dict = load_dictionaries(str(dict_dir))
            cleaned, _mapping = align_records(records, field_dict)
            return ToolResult(True, data=cleaned)
        except Exception as e:
            logger.exception("field_aligner 失败")
            return ToolResult(False, error=f"field_aligner: {e}")

    def normalize_units(self, records: list[dict]) -> ToolResult:
        """单位归一化。"""
        try:
            from app.tools.cleaners.unit_normalizer import normalize_records
            cleaned = normalize_records(records)
            return ToolResult(True, data=cleaned)
        except Exception as e:
            logger.exception("unit_normalizer 失败")
            return ToolResult(False, error=f"unit_normalizer: {e}")

    def deduplicate(self, records: list[dict]) -> ToolResult:
        """重复检测与去重。"""
        try:
            from app.tools.cleaners.duplicate_detector import deduplicate
            cleaned = deduplicate(records)
            return ToolResult(True, data=cleaned)
        except Exception as e:
            logger.exception("duplicate_detector 失败")
            return ToolResult(False, error=f"duplicate_detector: {e}")

    # ========== Analysis ==========

    def run_ppi(self, gene_list: list[str], task_id: str,
                output_file=None, species: int = 9606,
                score_threshold: float = 0.4) -> ToolResult:
        """STRING PPI 网络分析。

        Returns:
            ToolResult.data = AnalysisResult dict（含 chart_data.nodes/edges）
        """
        try:
            from app.tools.analysis.ppi_network import run_ppi_network
            result = run_ppi_network(gene_list, species, score_threshold, task_id)
            if output_file and result:
                self._write_json(output_file, result)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("ppi_network 失败")
            return ToolResult(False, error=f"ppi_network: {e}")

    def run_enrichment(self, gene_list: list[str], task_id: str,
                        output_file=None, library: str = "all") -> ToolResult:
        """GO/KEGG 富集分析（Enrichr）。

        Returns:
            ToolResult.data = AnalysisResult dict（含 stats_table 通路列表）
        """
        try:
            from app.tools.analysis.enrichment import run_enrichment as _run
            result = _run(gene_list, library, task_id)
            if output_file and result:
                self._write_json(output_file, result)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("enrichment 失败")
            return ToolResult(False, error=f"enrichment: {e}")

    def run_drug_target(self, compounds: list[str], task_id: str,
                         output_file=None, genes: list[str] | None = None) -> ToolResult:
        """药物-靶点结合分析（OpenTargets）。

        Args:
            compounds: 化合物名称列表
            task_id: 任务 ID
            output_file: 可选输出文件
            genes: 可选基因列表（用于反向查询药物）
        Returns:
            ToolResult.data = AnalysisResult dict
        """
        try:
            from app.tools.analysis.drug_target import run_drug_target_analysis
            result = run_drug_target_analysis(genes or [], compounds, task_id)
            if output_file and result:
                self._write_json(output_file, result)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("drug_target 失败")
            return ToolResult(False, error=f"drug_target: {e}")

    # ========== Export ==========

    def export_csv(self, records: list[dict], output_path) -> ToolResult:
        """CSV 导出。

        Returns:
            ToolResult.data = {"columns": [...], "rows": N}
        """
        try:
            from app.tools.export.to_csv import write_csv
            columns, rows = write_csv(records, str(output_path))
            return ToolResult(True, data={"columns": columns, "rows": rows})
        except Exception as e:
            logger.exception("to_csv 失败")
            return ToolResult(False, error=f"to_csv: {e}")

    # ========== 工具元数据 ==========

    # 各类别工具的元数据（名称 + 描述），供 /api/v1/tools 端点展示
    _TOOLS_METADATA: dict[str, list[dict]] = {
        "datasources": [
            {"name": "pubmed", "description": "PubMed 文献检索"},
            {"name": "openalex", "description": "OpenAlex 学术文献检索"},
            {"name": "semantic_scholar", "description": "Semantic Scholar 语义检索"},
            {"name": "arxiv", "description": "arXiv 预印本论文检索"},
            {"name": "geo", "description": "GEO 基因表达数据集"},
            {"name": "string", "description": "STRING 蛋白互作网络"},
            {"name": "kegg", "description": "KEGG 通路数据"},
            {"name": "pdb", "description": "PDB 蛋白质结构"},
            {"name": "tcmsp", "description": "TCMSP 中药化合物"},
            {"name": "ncbi", "description": "NCBI Gene/Protein"},
            {"name": "clinicaltrials", "description": "ClinicalTrials.gov 临床试验"},
            {"name": "tcga", "description": "TCGA/GDC 癌症基因组"},
            {"name": "drugbank", "description": "OpenTargets 药物-靶点"},
            {"name": "disgenet", "description": "DisGeNET 基因-疾病"},
            {"name": "pubchem", "description": "PubChem 化合物结构"},
        ],
        "parsers": [
            {"name": "pdf_table", "description": "PDF 表格提取"},
            {"name": "pdf_download", "description": "论文 PDF 下载"},
            {"name": "geo_soft", "description": "GEO SOFT 格式解析"},
            {"name": "pdb_parser", "description": "PDB 结构文件解析"},
            {"name": "fasta", "description": "FASTA 序列解析"},
            {"name": "network", "description": "STRING/SIF/GraphML 网络解析"},
        ],
        "cleaners": [
            {"name": "field_aligner", "description": "字段对齐"},
            {"name": "unit_normalizer", "description": "单位归一化"},
            {"name": "duplicate_detector", "description": "重复检测去重"},
        ],
        "analysis": [
            {"name": "diff_expr", "description": "差异表达分析"},
            {"name": "enrichment", "description": "GO/KEGG 富集分析"},
            {"name": "ppi_network", "description": "PPI 网络分析"},
            {"name": "hub_gene", "description": "Hub 基因识别"},
            {"name": "upstream_regulator", "description": "上游调控因子"},
            {"name": "drug_target", "description": "药物-靶点分析"},
            {"name": "survival", "description": "生存分析"},
        ],
        "export": [
            {"name": "to_csv", "description": "CSV 导出"},
            {"name": "to_excel", "description": "Excel 导出"},
            {"name": "to_report", "description": "Markdown 报告生成"},
        ],
    }

    def list_tools(self) -> dict[str, list[dict]]:
        """列出所有可用工具，按类别分组。

        供 /api/v1/tools 端点与启动日志使用。
        """
        return {
            category: [dict(t, script="(native)") for t in tools]
            for category, tools in self._TOOLS_METADATA.items()
        }

    # ========== 辅助方法 ==========

    @staticmethod
    def _write_json(path, data) -> None:
        """写入 JSON 文件（自动创建父目录）。"""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, default=str)


# 全局单例
_registry: ToolRegistry | None = None


def get_registry() -> ToolRegistry:
    """获取全局 ToolRegistry 单例。"""
    global _registry
    if _registry is None:
        _registry = ToolRegistry()
    return _registry
