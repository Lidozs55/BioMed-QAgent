"""工具注册表 — backend 原生模块函数的统一 facade。

设计原则：
- 无 subprocess、无 CLI 参数解析：每个方法直接调用 backend 内模块的领域函数
- 按类别组织：datasources / parsers / cleaners / analysis / io / optimization / viz / export
- 统一返回 ToolResult（.success / .data / .error / .signals），保持 orchestrator 简洁
- 每个方法是薄封装：调用领域函数 + 异常包装为 ToolResult

数据源接入分两条路径：
- 已接入 15 个模块级函数（pubmed/openalex/...）：通过 _get_ds_func 惰性加载
- dormant 13 个 BaseDataSource 子类（biogrid/chembl/...）：通过 DataSourceRegistry.search 调用
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

    # dormant 数据源：以 BaseDataSource 子类形式注册到 DataSourceRegistry
    # 这些数据源的检索入口是实例方法 search(self, query, max_results, task_id, **kwargs)
    # 特殊参数（mode/endpoint/organism/fetch_meta/dbname/sources/user_threshold）
    # 由各数据源类内部通过 kwargs.get(...) 处理默认值，故 run_datasource 直接透传 kwargs
    _DORMANT_DS_NAMES: frozenset = frozenset({
        "biogrid", "cbioportal", "chembl", "depmap", "enrichr",
        "ensembl", "gprofiler", "hgnc", "openfda", "opentargets",
        "reactome", "ucsc_xena", "uniprot",
    })

    @classmethod
    def _get_ds_func(cls, name: str):
        """惰性加载并缓存数据源检索函数（仅限模块级函数形式的 15 个数据源）。"""
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

        支持两类数据源：
        - 模块级函数（15 个）：通过 _get_ds_func 加载，特殊参数在此适配
        - BaseDataSource 子类（13 个 dormant）：通过 DataSourceRegistry.search 调用，
          特殊参数经 **kwargs 透传，由各类内部处理默认值

        kwargs 适配各数据源的特殊参数：
        - string: species (int, 默认 9606)
        - kegg:   species (str, 默认 "hsa")
        - disgenet: mode ("gene"|"disease", 默认 "gene")
        - ncbi:   db (str, 默认 "gene")
        - tcga:   search_type (str, 默认 "gene")
        - tcmsp:  无额外参数（返回 None → requires_crawl 信号）
        - dormant 数据源: mode/endpoint/organism/fetch_meta/dbname/sources/user_threshold
                         由各类内部 kwargs.get(...) 处理，无需在此显式适配
        """
        func = self._get_ds_func(name)
        if func is not None:
            # 模块级函数路径
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

        # dormant 数据源路径：通过 DataSourceRegistry 调用 BaseDataSource 子类
        if name in self._DORMANT_DS_NAMES:
            try:
                from app.tools.datasources.base_ds import get_datasource_registry
                ds = get_datasource_registry().get(name)
            except Exception as e:
                logger.exception("加载 DataSourceRegistry 失败: %s", name)
                return ToolResult(False, error=f"{name}: DataSourceRegistry 加载失败: {e}")
            if ds is None:
                return ToolResult(False, error=f"数据源未注册: {name}")
            try:
                records = ds.search(query, max_results, task_id, **kwargs)
                return ToolResult(True, data=records or [])
            except Exception as e:
                logger.exception("数据源 %s 检索失败", name)
                return ToolResult(False, error=f"{name}: {e}")

        return ToolResult(False, error=f"未知数据源: {name}")

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

    def trace_citations(self, records: list[dict], max_results: int = 20,
                         task_id: str = "T0",
                         direction: str = "both") -> ToolResult:
        """引用追溯 — 基于已有文献的引用网络扩展检索（OpenAlex）。

        对已检索文献中高被引的 top N 篇，追溯其参考文献（referenced_works）
        和被引文献（cited_by），用于系统综述式扩展检索。

        Args:
            records: 已检索的文献记录列表（取含 openalex_id 的 top 5 为种子）
            max_results: 每个方向返回的最大记录数
            task_id: 任务 ID
            direction: "refs" | "cited_by" | "both"
        Returns:
            ToolResult.data = 新文献记录列表（不含种子，由调用方去重）
        """
        try:
            from app.tools.datasources.citation_trace import trace_citations
            new_records = trace_citations(
                records, max_results, task_id, direction=direction,
            )
            return ToolResult(True, data=new_records or [])
        except Exception as e:
            logger.exception("trace_citations 失败")
            return ToolResult(False, error=f"trace_citations: {e}")

    def crawl_web(self, crawl_targets: list[dict],
                   task_id: str = "T0") -> ToolResult:
        """网页爬虫采集（fallback） — 对 requires_crawl 数据源执行爬取。

        输出 raw crawl record（含 raw_content），由 parse 阶段 LLMExtractor
        转换为结构化 DataRecord。

        Args:
            crawl_targets: 爬虫目标列表，每项 {"source", "query", "reason"}
            task_id: 任务 ID
        Returns:
            ToolResult.data = raw crawl record 列表（非 DataRecord）
        """
        try:
            from app.tools.datasources.web_crawler import WebCrawlerSource
            crawler = WebCrawlerSource()
            raw_records: list[dict] = []
            for target in crawl_targets:
                source = target.get("source", "web_crawler")
                query = target.get("query", "")
                if not query:
                    continue
                recs = crawler.search(query, max_results=20, task_id=task_id,
                                       source=source)
                raw_records.extend(recs)
                if recs:
                    logger.info("crawl_web: %s 爬取 %d 条原始记录",
                                source, len(recs))
                else:
                    logger.info("crawl_web: %s 无可用内容", source)
            return ToolResult(True, data=raw_records)
        except Exception as e:
            logger.exception("crawl_web 失败")
            return ToolResult(False, error=f"crawl_web: {e}")

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

    def parse_geo_soft(self, file_path, output_file=None) -> ToolResult:
        """解析 GEO SOFT 文件（.soft / .soft.gz）为 DataRecord 列表。

        每个 Sample 输出一条 record，fields 含表达矩阵。
        """
        try:
            from app.tools.parsers.geo_soft import GeoSoftParser
            parser = GeoSoftParser()
            records = parser.parse(str(file_path))
            if output_file and records:
                self._write_json(output_file, records)
            return ToolResult(True, data=records or [])
        except Exception as e:
            logger.exception("geo_soft 解析失败: %s", file_path)
            return ToolResult(False, error=f"geo_soft: {e}")

    def parse_fasta(self, file_path, output_file=None) -> ToolResult:
        """解析 FASTA / FASTQ 文件为 DataRecord 列表（每条序列一个 record）。

        自动识别 protein / dna 类型。
        """
        try:
            from app.tools.parsers.fasta import FastaParser
            parser = FastaParser()
            records = parser.parse(str(file_path))
            if output_file and records:
                self._write_json(output_file, records)
            return ToolResult(True, data=records or [])
        except Exception as e:
            logger.exception("fasta 解析失败: %s", file_path)
            return ToolResult(False, error=f"fasta: {e}")

    def parse_network(self, file_path, fmt: str = "auto",
                      output_file=None) -> ToolResult:
        """解析网络文件（STRING TSV / SIF / GraphML）为 DataRecord。

        Args:
            file_path: 网络文件路径
            fmt: 格式 "auto" | "string" | "sif" | "graphml"
            output_file: 可选输出 JSON
        Returns:
            ToolResult.data = 长度 1 的 records 列表（含 nodes/edges）
        """
        try:
            from app.tools.parsers.network import NetworkParser
            parser = NetworkParser()
            records = parser.parse(str(file_path), fmt=fmt)
            if output_file and records:
                self._write_json(output_file, records)
            return ToolResult(True, data=records or [])
        except Exception as e:
            logger.exception("network 解析失败: %s", file_path)
            return ToolResult(False, error=f"network: {e}")

    def parse_pdb(self, file_path, output_file=None) -> ToolResult:
        """解析 PDB 结构文件（.pdb / .ent）为 DataRecord。

        纯 Python 实现，不依赖 Biopython。
        """
        try:
            from app.tools.parsers.pdb import PdbParser
            parser = PdbParser()
            records = parser.parse(str(file_path))
            if output_file and records:
                self._write_json(output_file, records)
            return ToolResult(True, data=records or [])
        except Exception as e:
            logger.exception("pdb 解析失败: %s", file_path)
            return ToolResult(False, error=f"pdb: {e}")

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
        """单位归一化（ln→log2、log10→log2、μM→uM 等）。

        Returns:
            ToolResult.data = 归一化后的 records 列表
        """
        try:
            from app.tools.cleaners.unit_normalizer import normalize_records
            normalized, _changes = normalize_records(records)
            return ToolResult(True, data=normalized)
        except Exception as e:
            logger.exception("unit_normalizer 失败")
            return ToolResult(False, error=f"unit_normalizer: {e}")

    def deduplicate(self, records: list[dict]) -> ToolResult:
        """重复检测与去重（按 gene_symbol/compound_name/context 三元组归组）。

        Returns:
            ToolResult.data = 去重后的 records 列表
        """
        try:
            from app.tools.cleaners.duplicate_detector import deduplicate
            deduped, _report = deduplicate(records)
            return ToolResult(True, data=deduped)
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

    def run_diff_expression(self, records: list[dict], task_id: str,
                             p_threshold: float = 0.05,
                             lfc_threshold: float = 1.0,
                             output_file=None) -> ToolResult:
        """差异表达分析（基于 records 中的 log2fc/p_value 字段）。

        Args:
            records: DataRecord 列表（fields 需含 gene_symbol/log2fc/p_value）
            task_id: 任务 ID
            p_threshold: 显著性阈值（默认 0.05）
            lfc_threshold: |log2fc| 阈值（默认 1.0）
        Returns:
            ToolResult.data = AnalysisResult dict（含火山图 chart_data + stats_table）
        """
        try:
            from app.tools.analysis.differential_expression import run_diff_expression
            result = run_diff_expression(records, p_threshold, lfc_threshold, task_id)
            if output_file and result:
                self._write_json(output_file, result)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("differential_expression 失败")
            return ToolResult(False, error=f"differential_expression: {e}")

    def run_hub_gene(self, genes: list[str], task_id: str,
                     species: int = 9606, score_threshold: float = 0.4,
                     output_file=None,
                     ppi_result: dict | None = None) -> ToolResult:
        """Hub 基因识别（基于 STRING PPI 中心性分析）。

        优先复用 PPI 分析结果（避免重复调用 STRING API）。
        Args:
            genes: 基因 symbol 列表
            task_id: 任务 ID
            species: NCBI taxonomy ID（默认 9606 人类）
            score_threshold: STRING combined_score 阈值
            ppi_result: 可选，run_ppi 的返回结果。传入时从中提取
                        degrees/betweenness/closeness/chart_data/modules，
                        不再调用 STRING。
        Returns:
            ToolResult.data = hub_gene_result dict
        """
        try:
            from app.tools.analysis.hub_gene import (
                run_hub_gene_analysis, _build_centralities,
            )

            if ppi_result:
                # 复用 PPI 结果，不重新调用 STRING
                stats = ppi_result.get("stats_table", []) or []
                degrees = {r.get("gene", ""): int(r.get("degree", 0))
                           for r in stats if isinstance(r, dict)}
                betweenness = {r.get("gene", ""): float(r.get("betweenness", 0.0))
                               for r in stats if isinstance(r, dict)}
                closeness = {r.get("gene", ""): float(r.get("closeness", 0.0))
                             for r in stats if isinstance(r, dict)}
                chart_data = ppi_result.get("chart_data", {}) or {}
                params = ppi_result.get("parameters", {}) or {}
                modules = int(params.get("modules", 0)) if isinstance(params, dict) else 0
            else:
                centralities = _build_centralities(genes, species, score_threshold)
                if centralities is None:
                    degrees, betweenness, closeness, chart_data, modules = {}, {}, {}, {}, 0
                else:
                    degrees, betweenness, closeness, chart_data, modules, _ = centralities

            result = run_hub_gene_analysis(
                genes, degrees, betweenness, closeness, chart_data,
                modules, species, score_threshold, task_id,
            )
            if output_file and result:
                self._write_json(output_file, result)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("hub_gene 失败")
            return ToolResult(False, error=f"hub_gene: {e}")

    def run_upstream_regulator(self, genes: list[str], task_id: str,
                                species: int = 9606,
                                score_threshold: float = 0.4,
                                output_file=None,
                                ppi_edges: list | None = None) -> ToolResult:
        """上游调控因子分析（基于 STRING TF 互作）。

        优先复用 PPI 边数据（避免对每个基因串行调用 STRING API）。
        Args:
            genes: 基因 symbol 列表
            task_id: 任务 ID
            species: NCBI taxonomy ID
            score_threshold: STRING 阈值
            ppi_edges: 可选，PPI 分析的边数据列表。传入时从中提取
                       TF 互作，不对每个基因单独调用 STRING。
        Returns:
            ToolResult.data = AnalysisResult dict（含 TF-target 网络 chart_data）
        """
        try:
            from app.tools.analysis.upstream_regulator import run_upstream_regulator
            result = run_upstream_regulator(
                genes, species, score_threshold, task_id,
                ppi_edges=ppi_edges,
            )
            if output_file and result:
                self._write_json(output_file, result)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("upstream_regulator 失败")
            return ToolResult(False, error=f"upstream_regulator: {e}")

    def run_survival(self, gene: str, cohort: str, task_id: str,
                     input_path: str | None = None, max_samples: int = 200,
                     output_file=None) -> ToolResult:
        """生存分析（KM 曲线 + log-rank 检验，基于 TCGA GDC）。

        Args:
            gene: 基因 symbol（如 "TP53"）
            cohort: TCGA 队列（如 "TCGA-PAAD"）
            task_id: 任务 ID
            input_path: 可选，已有表达+临床 JSON 路径（避免 GDC 降级）
            max_samples: GDC 检索最大样本数
        Returns:
            ToolResult.data = survival_result dict
        """
        try:
            from app.tools.analysis.survival import run_survival_analysis
            result = run_survival_analysis(
                gene, cohort, input_path, max_samples, task_id,
            )
            if output_file and result:
                self._write_json(output_file, result)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("survival 失败")
            return ToolResult(False, error=f"survival: {e}")

    # ========== IO（格式转换） ==========

    def csv_to_json(self, input_path, task_id: str,
                    source_name: str = "csv") -> ToolResult:
        """CSV 文件转 DataRecord JSON 列表。

        Args:
            input_path: CSV 文件路径（UTF-8，首行表头）
            task_id: 任务 ID
            source_name: 默认数据源名（可被行内 source_name 列覆盖）
        Returns:
            ToolResult.data = DataRecord 列表
        """
        try:
            from app.tools.io.csv_to_json import convert
            records = convert(str(input_path), task_id, source_name)
            return ToolResult(True, data=records or [])
        except Exception as e:
            logger.exception("csv_to_json 失败: %s", input_path)
            return ToolResult(False, error=f"csv_to_json: {e}")

    def excel_to_json(self, input_path, task_id: str,
                      source_name: str = "excel",
                      sheet: str | None = None) -> ToolResult:
        """Excel(.xlsx) 转 DataRecord JSON 列表。

        Args:
            input_path: .xlsx 文件路径
            task_id: 任务 ID
            source_name: 默认数据源名
            sheet: 工作表名，None 时用第一个 sheet
        Returns:
            ToolResult.data = DataRecord 列表
        """
        try:
            from app.tools.io.excel_to_json import convert
            records = convert(str(input_path), task_id, source_name, sheet)
            return ToolResult(True, data=records or [])
        except Exception as e:
            logger.exception("excel_to_json 失败: %s", input_path)
            return ToolResult(False, error=f"excel_to_json: {e}")

    def json_to_csv(self, records: list[dict], output_path) -> ToolResult:
        """DataRecord JSON 列表转 CSV 文件（字段展平）。

        Args:
            records: DataRecord 列表
            output_path: 输出 CSV 路径（自动建父目录）
        Returns:
            ToolResult.data = {"rows": 写入记录数}
        """
        try:
            from app.tools.io.json_to_csv import convert
            rows = convert(records, str(output_path))
            return ToolResult(True, data={"rows": rows})
        except Exception as e:
            logger.exception("json_to_csv 失败")
            return ToolResult(False, error=f"json_to_csv: {e}")

    def merge_json(self, paths: list, task_id: str = "T0",
                   output_file=None) -> ToolResult:
        """合并多个 DataRecord JSON 文件（按 record_id 去重）。

        Args:
            paths: 输入路径列表（目录会被递归扫描 *.json）
            task_id: 任务 ID
            output_file: 可选，合并结果写入 JSON
        Returns:
            ToolResult.data = {"records": [...], "by_source": {source: count}}
        """
        try:
            from app.tools.io.merge_json import merge
            records, by_source = merge(paths)
            if output_file and records:
                self._write_json(output_file, records)
            return ToolResult(True, data={"records": records,
                                           "by_source": by_source})
        except Exception as e:
            logger.exception("merge_json 失败")
            return ToolResult(False, error=f"merge_json: {e}")

    # ========== Optimization（Stage Gate / 反思循环） ==========

    def expand_keywords(self, records: list[dict], expected_entities: dict,
                        dictionaries_dir) -> ToolResult:
        """达尔文循环关键词扩展（基于已有 records + 同义词索引）。

        Args:
            records: 已有 DataRecord 列表
            expected_entities: {"gene": set, "compound": set, ...}
            dictionaries_dir: dictionaries/ 目录（用于构建同义词索引）
        Returns:
            ToolResult.data = {"queries": [str], "entities": [dict], "by_strategy": dict}
        """
        try:
            from app.tools.optimization.keyword_expander import (
                expand_keywords as _expand, _build_alias_index,
            )
            alias_index = _build_alias_index(str(dictionaries_dir))
            queries, entities, by_strategy = _expand(
                records, expected_entities, alias_index,
            )
            return ToolResult(True, data={"queries": queries,
                                           "entities": entities,
                                           "by_strategy": by_strategy})
        except Exception as e:
            logger.exception("expand_keywords 失败")
            return ToolResult(False, error=f"expand_keywords: {e}")

    def evaluate_stage(self, records: list[dict], stage: str,
                       iteration: int, task_id: str,
                       expected_entities: dict) -> ToolResult:
        """Stage Gate 评估（coverage/confidence/conflict_rate/source_diversity）。

        Args:
            records: DataRecord 列表
            stage: 阶段名 search/acquire/parse/clean/analyze/export
            iteration: 当前迭代轮次
            task_id: 任务 ID
            expected_entities: {"gene": set, ...}
        Returns:
            ToolResult.data = EvaluationResult dict（含 metrics/passed/gaps/suggestions）
        """
        try:
            from app.tools.optimization.stage_evaluator import evaluate
            result = evaluate(records, stage, iteration, task_id,
                              expected_entities)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("evaluate_stage 失败")
            return ToolResult(False, error=f"evaluate_stage: {e}")

    def reflection_record(self, evaluation_path, action: str,
                          reflection_log_path, task_id: str = "default",
                          new_queries=None, new_sources=None,
                          new_analyses=None) -> ToolResult:
        """反思循环：记录一次迭代行动。

        Args:
            evaluation_path: EvaluationResult JSON 路径
            action: expand_search/add_source/deepen_analysis/refine_keywords/
                    request_user_input/accept
            reflection_log_path: ReflectionLog JSON 路径（会被写入）
        Returns:
            ToolResult.data = {"total_iterations": int, "action": str, "entry": dict}
        """
        try:
            from app.tools.optimization.reflection_loop import record
            result = record(evaluation_path, action, reflection_log_path,
                            task_id=task_id, new_queries=new_queries,
                            new_sources=new_sources, new_analyses=new_analyses)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("reflection_record 失败")
            return ToolResult(False, error=f"reflection_record: {e}")

    def reflection_decide(self, evaluation_path, reflection_log_path,
                          task_id: str = "default") -> ToolResult:
        """反思循环：决定下一步行动。

        Returns:
            ToolResult.data = {"action": str, "should_iterate": bool, "reason": str, ...}
        """
        try:
            from app.tools.optimization.reflection_loop import decide
            result = decide(evaluation_path, reflection_log_path, task_id=task_id)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("reflection_decide 失败")
            return ToolResult(False, error=f"reflection_decide: {e}")

    def reflection_finalize(self, reflection_log_path, output_path,
                            task_id: str = "default") -> ToolResult:
        """反思循环：生成最终总结。

        Returns:
            ToolResult.data = {"final_status": str, "convergence_score": float,
                                "total_iterations": int, "lessons_count": int, "summary": str}
        """
        try:
            from app.tools.optimization.reflection_loop import finalize
            result = finalize(reflection_log_path, output_path, task_id=task_id)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("reflection_finalize 失败")
            return ToolResult(False, error=f"reflection_finalize: {e}")

    # ========== Viz（图表可视化） ==========

    def plot_enrichment_bubble(self, data: dict, output_path,
                                title: str = "") -> ToolResult:
        """富集气泡图（GO/KEGG，取 top20 通路）。

        Args:
            data: AnalysisResult dict（含 term/p_value/overlap）
            output_path: 输出 PNG 路径
        Returns:
            ToolResult.data = {"chart": path, "data_points": int}
        """
        try:
            from app.tools.viz.enrichment_bubble import plot_enrichment_bubble
            result = plot_enrichment_bubble(data, str(output_path), title=title)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("plot_enrichment_bubble 失败")
            return ToolResult(False, error=f"plot_enrichment_bubble: {e}")

    def plot_heatmap(self, data: dict, output_path,
                      title: str = "") -> ToolResult:
        """基因表达矩阵热图（seaborn clustermap 双向聚类）。

        Args:
            data: 含 expression_matrix.{genes, samples, values} 的 dict
            output_path: 输出 PNG 路径
        Returns:
            ToolResult.data = {"chart": path, "data_points": int}
        """
        try:
            from app.tools.viz.heatmap import plot_heatmap
            result = plot_heatmap(data, str(output_path), title=title)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("plot_heatmap 失败")
            return ToolResult(False, error=f"plot_heatmap: {e}")

    def plot_network(self, data: dict, output_path,
                      title: str = "") -> ToolResult:
        """PPI 网络图（spring_layout，节点大小 ∝ degree）。

        Args:
            data: AnalysisResult dict（含 nodes/edges/hub_genes）
            output_path: 输出 PNG 路径
        Returns:
            ToolResult.data = {"chart": path, "data_points": int}
        """
        try:
            from app.tools.viz.network_plot import plot_network
            result = plot_network(data, str(output_path), title=title)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("plot_network 失败")
            return ToolResult(False, error=f"plot_network: {e}")

    def plot_volcano(self, data: dict, output_path,
                      title: str = "") -> ToolResult:
        """火山图（log2fc vs -log10 adj_p_value）。

        Args:
            data: AnalysisResult dict（含 gene/log2fc/adj_p_value）
            output_path: 输出 PNG 路径
        Returns:
            ToolResult.data = {"chart": path, "data_points": int}
        """
        try:
            from app.tools.viz.volcano_plot import plot_volcano
            result = plot_volcano(data, str(output_path), title=title)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("plot_volcano 失败")
            return ToolResult(False, error=f"plot_volcano: {e}")

    def extract_chart_data(self, image_path, output_path=None) -> ToolResult:
        """从图片提取图表数据（调用 Qwen-VL 多模态识别）。

        Args:
            image_path: 本地图片路径（png/jpg/jpeg/webp/bmp/gif）
            output_path: 可选，提取结果写入 JSON
        Returns:
            ToolResult.data = {"chart_type": str, "axes": dict,
                                "data_points": list, "legend": list}
        """
        try:
            from app.tools.viz.extract_chart_data import extract_chart_data
            result = extract_chart_data(str(image_path), output_path)
            return ToolResult(True, data=result)
        except Exception as e:
            logger.exception("extract_chart_data 失败: %s", image_path)
            return ToolResult(False, error=f"extract_chart_data: {e}")

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

    def export_excel(self, records: list[dict], output_path,
                     lineage: dict | None = None) -> ToolResult:
        """Excel 导出（含可选 Lineage sheet）。

        Args:
            records: DataRecord 列表
            output_path: 输出 .xlsx 路径
            lineage: 可选 provenance dict（含 nodes），生成 Lineage sheet
        Returns:
            ToolResult.data = {"rows": int, "sheets": [str]}
        """
        try:
            from app.tools.export.to_excel import write_excel
            rows, sheets = write_excel(records, str(output_path), lineage=lineage)
            return ToolResult(True, data={"rows": rows, "sheets": sheets})
        except Exception as e:
            logger.exception("to_excel 失败")
            return ToolResult(False, error=f"to_excel: {e}")

    def export_markdown_report(self, records: list[dict], task_id: str,
                                out_path, lineage: dict | None = None,
                                analysis_dir=None,
                                input_path: str | None = None) -> ToolResult:
        """生成 Markdown 综合报告（数据源统计/字段映射/质量/溯源/分析）。

        Args:
            records: DataRecord 列表
            task_id: 任务 ID
            out_path: 输出路径（用于查找同目录 field_mapping.json 和文件清单）
            lineage: 可选 provenance dict
            analysis_dir: 分析结果 JSON 所在目录（None 跳过分析节）
            input_path: 可选输入路径（备选查找 field_mapping.json）
        Returns:
            ToolResult.data = {"markdown": str, "sections": int}
        """
        try:
            from app.tools.export.to_report import build_report, render_markdown
            sections = build_report(records, lineage, task_id,
                                     analysis_dir, str(out_path), input_path)
            md = render_markdown(sections)
            # 落盘 report.md
            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(md)
            return ToolResult(True, data={"markdown": md,
                                           "sections": len(sections)})
        except Exception as e:
            logger.exception("to_report 失败")
            return ToolResult(False, error=f"to_report: {e}")

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
            {"name": "citation_trace", "description": "引用追溯（OpenAlex 参考文献与被引）"},
            {"name": "web_crawler", "description": "通用网页爬虫（fallback，输出原始文本供 LLM 提取）"},
            # dormant 13 个（BaseDataSource 子类，经 DataSourceRegistry 调用）
            {"name": "biogrid", "description": "BioGRID 蛋白互作"},
            {"name": "cbioportal", "description": "cBioPortal 癌症基因组"},
            {"name": "chembl", "description": "ChEMBL 化合物活性"},
            {"name": "depmap", "description": "DepMap 细胞系依赖性"},
            {"name": "enrichr", "description": "Enrichr 富集分析库"},
            {"name": "ensembl", "description": "Ensembl 基因组注释"},
            {"name": "gprofiler", "description": "g:Profiler 功能富集"},
            {"name": "hgnc", "description": "HGNC 基因命名"},
            {"name": "openfda", "description": "openFDA 药品不良事件"},
            {"name": "opentargets", "description": "OpenTargets 靶点-疾病"},
            {"name": "reactome", "description": "Reactome 通路"},
            {"name": "ucsc_xena", "description": "UCSC Xena 基因组数据"},
            {"name": "uniprot", "description": "UniProt 蛋白质"},
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
        "io": [
            {"name": "csv_to_json", "description": "CSV 转 DataRecord"},
            {"name": "excel_to_json", "description": "Excel 转 DataRecord"},
            {"name": "json_to_csv", "description": "DataRecord 转 CSV"},
            {"name": "merge_json", "description": "多 JSON 合并去重"},
        ],
        "optimization": [
            {"name": "keyword_expander", "description": "关键词扩展"},
            {"name": "stage_evaluator", "description": "Stage Gate 评估"},
            {"name": "reflection_loop", "description": "反思循环（record/decide/finalize）"},
        ],
        "viz": [
            {"name": "enrichment_bubble", "description": "富集气泡图"},
            {"name": "heatmap", "description": "表达热图"},
            {"name": "network_plot", "description": "PPI 网络图"},
            {"name": "volcano_plot", "description": "火山图"},
            {"name": "extract_chart_data", "description": "图表数据提取（Qwen-VL）"},
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
