"""技能定义 — 从 ToolRegistry._TOOLS_METADATA 自动生成 SkillManifest。

调用 register_all_skills() 读取所有工具元数据，为每个工具创建 SkillManifest
并注册到 SkillRegistry。在 Orchestrator 启动时调用一次即可。
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

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

            SkillRegistry.register_manifest(manifest)
            registered += 1

    logger.info("已注册 %d 个 skills（来自 %d 个类别）",
                registered, len(tools._TOOLS_METADATA))
    return registered
