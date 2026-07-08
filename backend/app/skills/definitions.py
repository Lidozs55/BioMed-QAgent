"""技能定义 — 从 ToolRegistry._TOOLS_METADATA 自动生成 SkillManifest。

调用 register_all_skills() 读取所有工具元数据，为每个工具创建 SkillManifest
并注册到 SkillRegistry。在 Orchestrator 启动时调用一次即可。
"""
from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

from app.skills.manifest import SkillInputField, SkillOutputField, SkillManifest
from app.skills.registry import SkillRegistry

if TYPE_CHECKING:
    from app.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

# ── 标签同义词 ──────────────────────────────────────────────────────
# 按 skill_id 扩展检索标签，提升 SkillRetriever 命中率
_TAG_SYNONYMS: dict[str, list[str]] = {
    # 文献
    "pubmed":           ["literature", "articles", "pubmed", "biomedical", "ncbi"],
    "openalex":         ["literature", "academic", "publications", "citation"],
    "semantic_scholar": ["literature", "semantic", "scholar", "academic"],
    "arxiv":            ["preprint", "physics", "cs", "math"],
    # 生物数据源
    "geo":              ["gene", "expression", "microarray", "rnaseq", "GEO"],
    "string":           ["ppi", "protein", "interaction", "network", "STRING"],
    "kegg":             ["pathway", "gene", "metabolism", "KEGG"],
    "pdb":              ["protein", "structure", "3d", "pdb"],
    "tcmsp":            ["tcm", "herb", "compound", "chinese medicine"],
    "ncbi":             ["gene", "protein", "nucleotide", "ncbi"],
    "clinicaltrials":   ["clinical", "trial", "drug", "intervention"],
    "tcga":             ["cancer", "genomics", "tcga", "gdc"],
    "drugbank":         ["drug", "target", "pharmacology", "opentargets"],
    "disgenet":         ["gene", "disease", "association", "disgenet"],
    "pubchem":          ["compound", "structure", "chemistry", "pubchem"],
    # citation / crawl
    "citation_trace":   ["citation", "reference", "trace", "openalex"],
    "web_crawler":      ["crawl", "web", "fallback", "scrape"],
    # dormant
    "biogrid":          ["ppi", "interaction", "biogrid"],
    "cbioportal":       ["cancer", "genomics", "cbioportal"],
    "chembl":           ["compound", "bioactivity", "chembl"],
    "depmap":           ["cell", "line", "dependency", "crispr"],
    "lincs":            ["drug", "signature", "l1000", "connectivity", "repurposing"],
    "pdc":              ["proteomics", "phosphoproteomics", "cptac", "cancer"],
    "enrichr":          ["enrichment", "go", "kegg", "pathway"],
    "ensembl":          ["genome", "annotation", "ensembl"],
    "gprofiler":        ["enrichment", "go", "functional"],
    "hgnc":             ["gene", "nomenclature", "hgnc"],
    "openfda":          ["drug", "adverse", "fda", "safety"],
    "opentargets":      ["target", "disease", "drug", "association"],
    "reactome":         ["pathway", "signaling", "reactome"],
    "ucsc_xena":        ["genomics", "expression", "xena"],
    "uniprot":          ["protein", "annotation", "uniprot"],
    "drugbank":         ["drug", "target", "pharmacology", "drugbank", "controlled"],
    "omim":             ["omim", "phenotype", "mendelian", "inheritance", "gene-disease"],
    "disgenet":         ["gene", "disease", "association", "disgenet", "controlled"],
    "genecards":        ["genecards", "gene", "function", "summary", "integrative"],
    "cnki":             ["cnki", "chinese", "literature", "中文", "知网", "crawl"],
    "wanfang":          ["wanfang", "chinese", "literature", "中文", "万方", "crawl"],
    # parsers
    "pdf_table":        ["pdf", "table", "extract", "caption"],
    "pdf_download":     ["pdf", "download", "openaccess"],
    "geo_soft":         ["geo", "soft", "expression", "parse"],
    "pdb_parser":       ["pdb", "structure", "3d", "parse"],
    "fasta":            ["fasta", "sequence", "dna", "protein"],
    "network":          ["network", "string", "sif", "graphml"],
    # cleaners
    "field_aligner":    ["field", "align", "normalize", "mapping"],
    "unit_normalizer":  ["unit", "normalize", "log", "convert"],
    "duplicate_detector": ["deduplicate", "duplicate", "unique"],
    # analysis
    "diff_expr":        ["differential", "expression", "volcano", "log2fc"],
    "enrichment":       ["go", "kegg", "pathway", "enrichment", "enrichr"],
    "ppi_network":      ["ppi", "protein", "interaction", "network", "string", "STRING"],
    "hub_gene":         ["hub", "centrality", "degree", "betweenness"],
    "upstream_regulator": ["tf", "transcription", "factor", "regulator"],
    "drug_target":      ["drug", "target", "pharmacology", "opentargets"],
    "survival":         ["survival", "km", "kaplan", "meier", "prognosis"],
    # io
    "csv_to_json":      ["csv", "import", "convert"],
    "excel_to_json":    ["excel", "xlsx", "import", "convert"],
    "json_to_csv":      ["json", "convert", "csv", "export"],
    "merge_json":       ["merge", "combine", "deduplicate"],
    # optimization
    "keyword_expander": ["keyword", "expand", "synonym", "query"],
    "stage_evaluator":  ["evaluate", "stage", "gate", "coverage"],
    "reflection_loop":  ["reflection", "iterate", "decide", "loop"],
    # viz
    "enrichment_bubble": ["bubble", "enrichment", "go", "chart"],
    "heatmap":          ["heatmap", "expression", "clustering"],
    "network_plot":     ["network", "ppi", "graph", "chart"],
    "volcano_plot":     ["volcano", "differential", "expression"],
    "extract_chart_data": ["chart", "extract", "qwen", "vision"],
    # export
    "to_csv":           ["csv", "export", "spreadsheet"],
    "to_excel":         ["excel", "xlsx", "export", "spreadsheet"],
    "to_report":        ["markdown", "report", "summary"],
}

# ── dormant 数据源列表 ───────────────────────────────────────────────
_DORMANT_DS: frozenset = frozenset({
    "biogrid", "cbioportal", "chembl", "cnki", "depmap", "disgenet", "drugbank",
    "enrichr", "ensembl", "genecards", "gprofiler", "hgnc",
    "lincs", "omim", "openfda", "opentargets", "pdc",
    "reactome", "ucsc_xena", "uniprot", "wanfang",
})


# ── 标签派生 ───────────────────────────────────────────────────────
def _derive_tags(skill_id: str, category: str) -> list[str]:
    """从 skill_id 和 category 派生初始标签集合。"""
    tags: list[str] = []

    # 拆解 skill_id 中的字母数字词块作为标签
    import re
    tokens = re.split(r"[_\-.]+", skill_id.lower())
    tags.extend(t for t in tokens if t and len(t) >= 2)

    # 添加 category 本身
    if category:
        tags.append(category)

    # 添加同义词映射
    synonyms = _TAG_SYNONYMS.get(skill_id, [])
    tags.extend(synonyms)

    # 去重，保序
    seen: set[str] = set()
    result: list[str] = []
    for t in tags:
        if t not in seen:
            seen.add(t)
            result.append(t)
    return result


# ── 输入/输出字段派生 ──────────────────────────────────────────────
def _derive_inputs(skill_id: str, category: str) -> list[SkillInputField]:
    """按类别推导期望输入字段。"""
    if category == "datasources":
        if skill_id == "web_crawler":
            return [
                SkillInputField(name="crawl_targets", type="list[dict]",
                                required=True,
                                description="爬取目标列表 [{source, query, reason}]"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
            ]
        if skill_id == "citation_trace":
            return [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="已检索的文献记录列表"),
                SkillInputField(name="max_results", type="int", required=False,
                                default=20, description="最大返回记录数"),
                SkillInputField(name="task_id", type="str", required=False,
                                default="T0", description="任务 ID"),
                SkillInputField(name="direction", type="str", required=False,
                                default="both", description="追溯方向"),
            ]
        return [
            SkillInputField(name="query", type="str", required=True,
                            description="检索关键词"),
            SkillInputField(name="max_results", type="int", required=False,
                            default=20, description="最大返回记录数"),
            SkillInputField(name="task_id", type="str", required=False,
                            default="T0", description="任务 ID"),
        ]
    if category == "parsers":
        if skill_id == "pdf_download":
            return [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="含 pdf_url 的文献记录列表"),
                SkillInputField(name="pdf_dir", type="str", required=True,
                                description="PDF 保存目录"),
                SkillInputField(name="max_download", type="int", required=False,
                                default=5, description="最大下载数"),
                SkillInputField(name="task_id", type="str", required=False,
                                default="T0", description="任务 ID"),
            ]
        if skill_id == "network":
            return [
                SkillInputField(name="file_path", type="str", required=True,
                                description="网络文件路径"),
                SkillInputField(name="fmt", type="str", required=False,
                                default="auto", description="格式：auto/string/sif/graphml"),
            ]
        return [
            SkillInputField(name="file_path", type="str", required=True,
                            description="输入文件路径"),
            SkillInputField(name="output_file", type="str", required=False,
                            description="可选输出 JSON 路径"),
        ]
    if category == "cleaners":
        if skill_id == "field_aligner":
            return [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="DataRecord 列表"),
                SkillInputField(name="dict_dir", type="str", required=True,
                                description="dictionaries/ 目录路径"),
            ]
        return [
            SkillInputField(name="records", type="list[dict]", required=True,
                            description="DataRecord 列表"),
        ]
    if category == "analysis":
        common = {
            "diff_expr": [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="含 log2fc/p_value 的 DataRecord 列表"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="p_threshold", type="float", required=False,
                                default=0.05, description="显著性阈值"),
                SkillInputField(name="lfc_threshold", type="float", required=False,
                                default=1.0, description="|log2fc| 阈值"),
            ],
            "enrichment": [
                SkillInputField(name="gene_list", type="list[str]", required=True,
                                description="基因 symbol 列表"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="library", type="str", required=False,
                                default="all", description="基因集库名"),
            ],
            "ppi_network": [
                SkillInputField(name="gene_list", type="list[str]", required=True,
                                description="基因 symbol 列表"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="species", type="int", required=False,
                                default=9606, description="NCBI taxonomy ID"),
                SkillInputField(name="score_threshold", type="float", required=False,
                                default=0.4, description="STRING combined_score 阈值"),
            ],
            "hub_gene": [
                SkillInputField(name="genes", type="list[str]", required=True,
                                description="基因 symbol 列表"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="species", type="int", required=False,
                                default=9606, description="NCBI taxonomy ID"),
                SkillInputField(name="score_threshold", type="float", required=False,
                                default=0.4, description="STRING 阈值"),
                SkillInputField(name="ppi_result", type="dict", required=False,
                                description="复用 run_ppi 的返回结果"),
            ],
            "upstream_regulator": [
                SkillInputField(name="genes", type="list[str]", required=True,
                                description="基因 symbol 列表"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="species", type="int", required=False,
                                default=9606, description="NCBI taxonomy ID"),
                SkillInputField(name="score_threshold", type="float", required=False,
                                default=0.4, description="STRING 阈值"),
                SkillInputField(name="ppi_edges", type="list", required=False,
                                description="复用 PPI 边的数据"),
            ],
            "drug_target": [
                SkillInputField(name="compounds", type="list[str]", required=True,
                                description="化合物名称列表"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="genes", type="list[str]", required=False,
                                description="可选基因列表"),
            ],
            "survival": [
                SkillInputField(name="gene", type="str", required=True,
                                description="基因 symbol"),
                SkillInputField(name="cohort", type="str", required=True,
                                description="TCGA 队列名"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="input_path", type="str", required=False,
                                description="已有表达+临床 JSON 路径"),
                SkillInputField(name="max_samples", type="int", required=False,
                                default=200, description="GDC 最大样本数"),
            ],
        }
        result = common.get(skill_id)
        if result:
            return [SkillInputField(**f.model_dump()) for f in result]  # type: ignore[arg-type]
        return [
            SkillInputField(name="inputs", type="dict", required=True,
                            description="分析输入参数"),
        ]
    if category == "io":
        common = {
            "csv_to_json": [
                SkillInputField(name="input_path", type="str", required=True,
                                description="CSV 文件路径"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="source_name", type="str", required=False,
                                default="csv", description="数据源名"),
            ],
            "excel_to_json": [
                SkillInputField(name="input_path", type="str", required=True,
                                description="Excel 文件路径"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="source_name", type="str", required=False,
                                default="excel", description="数据源名"),
                SkillInputField(name="sheet", type="str", required=False,
                                description="工作表名"),
            ],
            "json_to_csv": [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="DataRecord 列表"),
                SkillInputField(name="output_path", type="str", required=True,
                                description="输出 CSV 路径"),
            ],
            "merge_json": [
                SkillInputField(name="paths", type="list", required=True,
                                description="输入路径列表"),
                SkillInputField(name="task_id", type="str", required=False,
                                default="T0", description="任务 ID"),
                SkillInputField(name="output_file", type="str", required=False,
                                description="可选输出 JSON"),
            ],
        }
        result = common.get(skill_id)
        if result:
            return [SkillInputField(**f.model_dump()) for f in result]  # type: ignore[arg-type]
        return [
            SkillInputField(name="inputs", type="dict", required=True,
                            description="IO 操作参数"),
        ]
    if category == "optimization":
        common = {
            "keyword_expander": [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="已有 DataRecord 列表"),
                SkillInputField(name="expected_entities", type="dict", required=True,
                                description="期望实体集"),
                SkillInputField(name="dictionaries_dir", type="str", required=True,
                                description="dictionaries/ 目录"),
            ],
            "stage_evaluator": [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="DataRecord 列表"),
                SkillInputField(name="stage", type="str", required=True,
                                description="阶段名"),
                SkillInputField(name="iteration", type="int", required=True,
                                description="当前迭代轮次"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="expected_entities", type="dict", required=True,
                                description="期望实体集"),
            ],
            "reflection_loop": [
                SkillInputField(name="evaluation_path", type="str", required=True,
                                description="EvaluationResult JSON 路径"),
                SkillInputField(name="reflection_log_path", type="str", required=True,
                                description="ReflectionLog JSON 路径"),
                SkillInputField(name="task_id", type="str", required=False,
                                default="default", description="任务 ID"),
                SkillInputField(name="action", type="str", required=False,
                                description="记录/决定/终结操作"),
            ],
        }
        result = common.get(skill_id)
        if result:
            return [SkillInputField(**f.model_dump()) for f in result]  # type: ignore[arg-type]
        return [
            SkillInputField(name="inputs", type="dict", required=True,
                            description="优化参数"),
        ]
    if category == "viz":
        common = {
            "extract_chart_data": [
                SkillInputField(name="image_path", type="str", required=True,
                                description="本地图片路径"),
                SkillInputField(name="output_path", type="str", required=False,
                                description="可选输出 JSON"),
            ],
        }
        result = common.get(skill_id)
        if result:
            return [SkillInputField(**f.model_dump()) for f in result]  # type: ignore[arg-type]
        # generic chart plotting
        return [
            SkillInputField(name="data", type="dict", required=True,
                            description="AnalysisResult dict"),
            SkillInputField(name="output_path", type="str", required=True,
                            description="输出 PNG 路径"),
            SkillInputField(name="title", type="str", required=False,
                            default="", description="图表标题"),
        ]
    if category == "export":
        common = {
            "to_csv": [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="DataRecord 列表"),
                SkillInputField(name="output_path", type="str", required=True,
                                description="输出 CSV 路径"),
            ],
            "to_excel": [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="DataRecord 列表"),
                SkillInputField(name="output_path", type="str", required=True,
                                description="输出 .xlsx 路径"),
                SkillInputField(name="lineage", type="dict", required=False,
                                description="可选 provenance dict"),
            ],
            "to_report": [
                SkillInputField(name="records", type="list[dict]", required=True,
                                description="DataRecord 列表"),
                SkillInputField(name="task_id", type="str", required=True,
                                description="任务 ID"),
                SkillInputField(name="out_path", type="str", required=True,
                                description="输出路径"),
                SkillInputField(name="lineage", type="dict", required=False,
                                description="可选 provenance dict"),
                SkillInputField(name="analysis_dir", type="str", required=False,
                                description="分析结果 JSON 目录"),
                SkillInputField(name="input_path", type="str", required=False,
                                description="可选输入路径"),
            ],
        }
        result = common.get(skill_id)
        if result:
            return [SkillInputField(**f.model_dump()) for f in result]  # type: ignore[arg-type]
        return [
            SkillInputField(name="inputs", type="dict", required=True,
                            description="导出参数"),
        ]
    return []


def _derive_outputs(skill_id: str, category: str) -> list[SkillOutputField]:
    """按类别推导期望输出字段。"""
    if category == "viz":
        return [
            SkillOutputField(name="chart", type="str",
                             description="输出 PNG 路径"),
            SkillOutputField(name="data_points", type="int",
                             description="数据点数量"),
        ]
    if category == "export":
        return [
            SkillOutputField(name="rows", type="int", description="导出行数"),
        ]
    if category == "analysis":
        return [
            SkillOutputField(name="records", type="list[dict]",
                             description="分析结果数据"),
            SkillOutputField(name="chart_data", type="dict",
                             description="图表数据"),
        ]
    if category == "optimization":
        return [
            SkillOutputField(name="data", type="dict", description="优化结果"),
        ]
    if category == "io":
        return [
            SkillOutputField(name="records", type="list[dict]",
                             description="转换后的记录列表"),
        ]
    if category == "cleaners":
        return [
            SkillOutputField(name="records", type="list[dict]",
                             description="清洗后的记录列表"),
        ]
    if category == "parsers":
        return [
            SkillOutputField(name="records", type="list[dict]",
                             description="解析后的记录列表"),
        ]
    if category == "datasources":
        return [
            SkillOutputField(name="records", type="list[dict]",
                             description="检索结果记录列表"),
        ]
    return [
        SkillOutputField(name="result", type="any", description="工具返回结果"),
    ]


# ── Executor Map ─────────────────────────────────────────────────────
# skill_id → executor factory，输入 (inputs: dict) 输出 ToolResult
# 实现在 register_all_skills() 的闭包中惰性绑定，避免循环导入

# 注：executor 在 register_all_skills() 内通过闭包创建，
# 此处 _EXECUTOR_SKIP 标记哪些 skill 不需要 executor（如 dormant 数据源）
_EXECUTOR_SKIP: set[str] = set(_DORMANT_DS) | {"citation_trace", "web_crawler"}


# ── 注册入口 ───────────────────────────────────────────────────────
def register_all_skills() -> int:
    """从 ToolRegistry._TOOLS_METADATA 自动生成 SkillManifest 并注册。

    每个工具条目生成：
    1. SkillManifest（含派生 inputs/outputs/tags）
    2. executor 闭包（惰性绑定 ToolRegistry 实例方法）

    Returns:
        成功注册的 skills 数量
    """
    from app.tools.registry import get_registry

    tools = get_registry()
    registered: int = 0

    for category, entries in tools._TOOLS_METADATA.items():
        for entry in entries:
            name: str = entry["name"]
            description: str = entry.get("description", "")

            # ── 构建 SkillManifest ──
            tags = _derive_tags(name, category)
            inputs_spec = _derive_inputs(name, category)
            outputs_spec = _derive_outputs(name, category)
            version = "dormant" if name in _DORMANT_DS else "active"

            # 展示名：将 skill_id 转为 Title Case
            display_name = name.replace("_", " ").title()

            manifest = SkillManifest(
                skill_id=name,
                name=display_name,
                description=description,
                category=category,
                tags=tags,
                inputs=inputs_spec,
                outputs=outputs_spec,
                version=version,
            )

            # ── 构建 executor 闭包 ──
            executor = _build_executor(name, category, tools)

            SkillRegistry.register_manifest(manifest, executor=executor)
            registered += 1

    logger.info("已注册 %d 个 skills（来自 %d 个类别）",
                registered, len(tools._TOOLS_METADATA))
    return registered


def _build_executor(skill_id: str, category: str, tools: ToolRegistry):
    """为给定 skill 构建 executor 闭包。

    返回一个 async callable (inputs: dict) -> SkillResult，
    内部委托给 ToolRegistry 实例方法。
    """
    if skill_id in _DORMANT_DS:
        return None

    from app.skills.executor import SkillResult

    # ── 按类别分发 ──

    if category == "datasources":
        if skill_id == "citation_trace":
            async def _exec(inputs: dict):
                try:
                    result = tools.trace_citations(
                        records=inputs.get("records", []),
                        max_results=inputs.get("max_results", 20),
                        task_id=inputs.get("task_id", "T0"),
                        direction=inputs.get("direction", "both"),
                    )
                    return SkillResult(
                        success=result.success,
                        data=result.data,
                        error=result.error,
                        metrics={"signals": result.signals},
                    )
                except Exception as e:
                    logger.exception("citation_trace executor 失败")
                    return SkillResult(False, error=str(e))

            return _exec

        if skill_id == "web_crawler":
            async def _exec(inputs: dict):
                try:
                    result = tools.crawl_web(
                        crawl_targets=inputs.get("crawl_targets", []),
                        task_id=inputs.get("task_id", "T0"),
                    )
                    return SkillResult(
                        success=result.success,
                        data=result.data,
                        error=result.error,
                        metrics={"signals": result.signals},
                    )
                except Exception as e:
                    logger.exception("web_crawler executor 失败")
                    return SkillResult(False, error=str(e))

            return _exec

        # 通用数据源（含 dormant）
        async def _exec(inputs: dict):
            try:
                result = tools.run_datasource(
                    name=skill_id,
                    query=inputs.get("query", ""),
                    max_results=inputs.get("max_results", 20),
                    task_id=inputs.get("task_id", "T0"),
                )
                return SkillResult(
                    success=result.success,
                    data=result.data,
                    error=result.error,
                    metrics={"signals": result.signals},
                )
            except Exception as e:
                logger.exception("datasource %s executor 失败", skill_id)
                return SkillResult(False, error=str(e))

        return _exec

    if category == "parsers":
        parser_methods: dict[str, str] = {
            "pdf_table":    "parse_pdf_table",
            "pdf_download": "download_pdfs",
            "geo_soft":     "parse_geo_soft",
            "pdb_parser":   "parse_pdb",
            "fasta":        "parse_fasta",
            "network":      "parse_network",
        }
        method_name = parser_methods.get(skill_id)
        assert method_name, f"Parser method not found for skill_id={skill_id}"

        async def _exec(inputs: dict):
            try:
                meth = getattr(tools, method_name)
                if skill_id == "pdf_download":
                    result = meth(
                        records=inputs.get("records", []),
                        pdf_dir=inputs["pdf_dir"],
                        max_download=inputs.get("max_download", 5),
                        task_id=inputs.get("task_id", "T0"),
                    )
                elif skill_id == "network":
                    result = meth(
                        file_path=inputs["file_path"],
                        fmt=inputs.get("fmt", "auto"),
                    )
                else:
                    kwargs = {"file_path": inputs["file_path"]}
                    if "output_file" in inputs:
                        kwargs["output_file"] = inputs["output_file"]
                    result = meth(**kwargs)
                return SkillResult(
                    success=result.success,
                    data=result.data,
                    error=result.error,
                    metrics={"signals": result.signals},
                )
            except Exception as e:
                logger.exception("parser %s executor 失败", skill_id)
                return SkillResult(False, error=str(e))

        return _exec

    if category == "cleaners":
        cleaner_methods: dict[str, str] = {
            "field_aligner":      "align_fields",
            "unit_normalizer":    "normalize_units",
            "duplicate_detector": "deduplicate",
        }
        method_name = cleaner_methods.get(skill_id)
        assert method_name, f"Cleaner method not found for skill_id={skill_id}"

        async def _exec(inputs: dict):
            try:
                meth = getattr(tools, method_name)
                if skill_id == "field_aligner":
                    result = meth(
                        records=inputs.get("records", []),
                        dict_dir=inputs["dict_dir"],
                    )
                else:
                    result = meth(records=inputs.get("records", []))
                return SkillResult(
                    success=result.success,
                    data=result.data,
                    error=result.error,
                    metrics={"signals": result.signals},
                )
            except Exception as e:
                logger.exception("cleaner %s executor 失败", skill_id)
                return SkillResult(False, error=str(e))

        return _exec

    if category == "analysis":
        analysis_methods: dict[str, str] = {
            "diff_expr":          "run_diff_expression",
            "enrichment":         "run_enrichment",
            "ppi_network":        "run_ppi",
            "hub_gene":           "run_hub_gene",
            "upstream_regulator": "run_upstream_regulator",
            "drug_target":        "run_drug_target",
            "survival":           "run_survival",
        }
        method_name = analysis_methods.get(skill_id)
        assert method_name, f"Analysis method not found for skill_id={skill_id}"

        async def _exec(inputs: dict):
            try:
                meth = getattr(tools, method_name)
                if skill_id == "diff_expr":
                    result = meth(
                        records=inputs.get("records", []),
                        task_id=inputs.get("task_id", "T0"),
                        p_threshold=inputs.get("p_threshold", 0.05),
                        lfc_threshold=inputs.get("lfc_threshold", 1.0),
                    )
                elif skill_id == "enrichment":
                    result = meth(
                        gene_list=inputs.get("gene_list", []),
                        task_id=inputs.get("task_id", "T0"),
                        library=inputs.get("library", "all"),
                    )
                elif skill_id == "ppi_network":
                    result = meth(
                        gene_list=inputs.get("gene_list", []),
                        task_id=inputs.get("task_id", "T0"),
                        species=inputs.get("species", 9606),
                        score_threshold=inputs.get("score_threshold", 0.4),
                    )
                elif skill_id == "hub_gene":
                    result = meth(
                        genes=inputs.get("genes", []),
                        task_id=inputs.get("task_id", "T0"),
                        species=inputs.get("species", 9606),
                        score_threshold=inputs.get("score_threshold", 0.4),
                        ppi_result=inputs.get("ppi_result"),
                    )
                elif skill_id == "upstream_regulator":
                    result = meth(
                        genes=inputs.get("genes", []),
                        task_id=inputs.get("task_id", "T0"),
                        species=inputs.get("species", 9606),
                        score_threshold=inputs.get("score_threshold", 0.4),
                        ppi_edges=inputs.get("ppi_edges"),
                    )
                elif skill_id == "drug_target":
                    result = meth(
                        compounds=inputs.get("compounds", []),
                        task_id=inputs.get("task_id", "T0"),
                        genes=inputs.get("genes"),
                    )
                elif skill_id == "survival":
                    result = meth(
                        gene=inputs.get("gene", ""),
                        cohort=inputs.get("cohort", ""),
                        task_id=inputs.get("task_id", "T0"),
                        input_path=inputs.get("input_path"),
                        max_samples=inputs.get("max_samples", 200),
                    )
                else:
                    result = meth()
                return SkillResult(
                    success=result.success,
                    data=result.data,
                    error=result.error,
                    metrics={"signals": result.signals},
                )
            except Exception as e:
                logger.exception("analysis %s executor 失败", skill_id)
                return SkillResult(False, error=str(e))

        return _exec

    if category == "io":
        io_methods: dict[str, str] = {
            "csv_to_json":   "csv_to_json",
            "excel_to_json": "excel_to_json",
            "json_to_csv":   "json_to_csv",
            "merge_json":    "merge_json",
        }
        method_name = io_methods.get(skill_id)
        assert method_name, f"IO method not found for skill_id={skill_id}"

        async def _exec(inputs: dict):
            try:
                meth = getattr(tools, method_name)
                if skill_id == "csv_to_json":
                    result = meth(
                        input_path=inputs["input_path"],
                        task_id=inputs.get("task_id", "T0"),
                        source_name=inputs.get("source_name", "csv"),
                    )
                elif skill_id == "excel_to_json":
                    result = meth(
                        input_path=inputs["input_path"],
                        task_id=inputs.get("task_id", "T0"),
                        source_name=inputs.get("source_name", "excel"),
                        sheet=inputs.get("sheet"),
                    )
                elif skill_id == "json_to_csv":
                    result = meth(
                        records=inputs.get("records", []),
                        output_path=inputs["output_path"],
                    )
                elif skill_id == "merge_json":
                    result = meth(
                        paths=inputs.get("paths", []),
                        task_id=inputs.get("task_id", "T0"),
                        output_file=inputs.get("output_file"),
                    )
                else:
                    result = meth()
                return SkillResult(
                    success=result.success,
                    data=result.data,
                    error=result.error,
                    metrics={"signals": result.signals},
                )
            except Exception as e:
                logger.exception("io %s executor 失败", skill_id)
                return SkillResult(False, error=str(e))

        return _exec

    if category == "optimization":
        opt_methods: dict[str, str] = {
            "keyword_expander": "expand_keywords",
            "stage_evaluator":  "evaluate_stage",
            "reflection_loop":  "reflection_record",
        }
        method_name = opt_methods.get(skill_id)
        assert method_name, f"Optimization method not found for skill_id={skill_id}"

        async def _exec(inputs: dict):
            try:
                meth = getattr(tools, method_name)
                if skill_id == "keyword_expander":
                    result = meth(
                        records=inputs.get("records", []),
                        expected_entities=inputs.get("expected_entities", {}),
                        dictionaries_dir=inputs["dictionaries_dir"],
                    )
                elif skill_id == "stage_evaluator":
                    result = meth(
                        records=inputs.get("records", []),
                        stage=inputs.get("stage", "search"),
                        iteration=inputs.get("iteration", 0),
                        task_id=inputs.get("task_id", "T0"),
                        expected_entities=inputs.get("expected_entities", {}),
                    )
                elif skill_id == "reflection_loop":
                    result = meth(
                        evaluation_path=inputs["evaluation_path"],
                        action=inputs.get("action", "accept"),
                        reflection_log_path=inputs["reflection_log_path"],
                        task_id=inputs.get("task_id", "default"),
                    )
                else:
                    result = meth()
                return SkillResult(
                    success=result.success,
                    data=result.data,
                    error=result.error,
                    metrics={"signals": result.signals},
                )
            except Exception as e:
                logger.exception("optimization %s executor 失败", skill_id)
                return SkillResult(False, error=str(e))

        return _exec

    if category == "viz":
        viz_methods: dict[str, str] = {
            "enrichment_bubble":  "plot_enrichment_bubble",
            "heatmap":            "plot_heatmap",
            "network_plot":       "plot_network",
            "volcano_plot":       "plot_volcano",
            "extract_chart_data": "extract_chart_data",
        }
        method_name = viz_methods.get(skill_id)
        assert method_name, f"Viz method not found for skill_id={skill_id}"

        async def _exec(inputs: dict):
            try:
                meth = getattr(tools, method_name)
                if skill_id == "extract_chart_data":
                    result = meth(
                        image_path=inputs["image_path"],
                        output_path=inputs.get("output_path"),
                    )
                else:
                    result = meth(
                        data=inputs.get("data", {}),
                        output_path=inputs["output_path"],
                        title=inputs.get("title", ""),
                    )
                return SkillResult(
                    success=result.success,
                    data=result.data,
                    error=result.error,
                    metrics={"signals": result.signals},
                )
            except Exception as e:
                logger.exception("viz %s executor 失败", skill_id)
                return SkillResult(False, error=str(e))

        return _exec

    if category == "export":
        export_methods: dict[str, str] = {
            "to_csv":    "export_csv",
            "to_excel":  "export_excel",
            "to_report": "export_markdown_report",
        }
        method_name = export_methods.get(skill_id)
        assert method_name, f"Export method not found for skill_id={skill_id}"

        async def _exec(inputs: dict):
            try:
                meth = getattr(tools, method_name)
                if skill_id == "to_csv":
                    result = meth(
                        records=inputs.get("records", []),
                        output_path=inputs["output_path"],
                    )
                elif skill_id == "to_excel":
                    result = meth(
                        records=inputs.get("records", []),
                        output_path=inputs["output_path"],
                        lineage=inputs.get("lineage"),
                    )
                elif skill_id == "to_report":
                    result = meth(
                        records=inputs.get("records", []),
                        task_id=inputs.get("task_id", "T0"),
                        out_path=inputs["out_path"],
                        lineage=inputs.get("lineage"),
                        analysis_dir=inputs.get("analysis_dir"),
                        input_path=inputs.get("input_path"),
                    )
                else:
                    result = meth()
                return SkillResult(
                    success=result.success,
                    data=result.data,
                    error=result.error,
                    metrics={"signals": result.signals},
                )
            except Exception as e:
                logger.exception("export %s executor 失败", skill_id)
                return SkillResult(False, error=str(e))

        return _exec

    # did not match any category
    logger.warning("无法为 %s (category=%s) 构建 executor", skill_id, category)
    return None
