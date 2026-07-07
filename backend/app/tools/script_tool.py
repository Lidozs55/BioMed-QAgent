"""脚本运行器 — 通过 subprocess 调用 biomed-data-agent-skill/scripts/ 中的脚本。

这是后端与已测试脚本之间的桥梁：后端负责编排，脚本负责执行。
所有脚本遵循统一约定：CLI 参数输入，JSON 输出到 stdout 或 --out 文件。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import logging
from pathlib import Path
from typing import Any

from app.config import SCRIPTS_DIR
from app.utils.paths import ensure_scripts_on_path

logger = logging.getLogger(__name__)


class ScriptResult:
    """脚本执行结果。"""

    def __init__(self, success: bool, data: list | dict | None = None,
                 error: str = "", stderr: str = "",
                 signals: dict | None = None):
        self.success = success
        self.data = data
        self.error = error
        self.stderr = stderr
        # 非记录信号（如 requires_crawl），供 acquire 阶段识别
        self.signals = signals or {}

    def __repr__(self):
        if self.success:
            n = len(self.data) if isinstance(self.data, list) else 1
            return f"ScriptResult(ok, {n} records)"
        return f"ScriptResult(fail: {self.error[:80]})"


class ScriptRunner:
    """执行单个脚本并解析输出。

    Args:
        script_path: 相对于 scripts/ 的路径，如 "datasources/pubmed_client.py"
    """

    def __init__(self, script_path: str, name: str = "", description: str = ""):
        self.script_path = script_path
        self.name = name or Path(script_path).stem
        self.description = description
        self.full_path = SCRIPTS_DIR / script_path
        if not self.full_path.exists():
            logger.warning("脚本不存在: %s", self.full_path)

    def run(self, args: list[str] = None, timeout: int = 120,
            env: dict | None = None) -> ScriptResult:
        """执行脚本，返回 ScriptResult。

        Args:
            args: 命令行参数列表，如 ["--query", "cancer", "--max", "20"]
            timeout: 超时秒数
            env: 额外环境变量
        """
        args = args or []
        if not self.full_path.exists():
            return ScriptResult(False, error=f"脚本不存在: {self.full_path}")

        cmd = [sys.executable, str(self.full_path)] + args
        logger.info("执行脚本: %s %s", self.name, " ".join(args[:4]))

        # 合并环境变量
        run_env = os.environ.copy()
        if env:
            run_env.update(env)

        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=run_env,
                cwd=str(SCRIPTS_DIR),  # 在 scripts/ 目录下运行，使脚本能 import _base
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired:
            return ScriptResult(False, error=f"脚本超时 ({timeout}s)")
        except Exception as e:
            return ScriptResult(False, error=f"脚本执行异常: {e}")

        if proc.returncode != 0:
            # emit_error() 将错误 JSON 写到 stdout（非 stderr），需优先解析
            stdout = proc.stdout.strip()
            err_msg = ""
            if stdout:
                try:
                    data = json.loads(stdout.split("\n")[-1])
                    if isinstance(data, dict) and data.get("status") == "error":
                        err_msg = data.get("message", "") or data.get("error", "")
                except (json.JSONDecodeError, IndexError):
                    pass
            # 回退到 stderr 最后一行
            if not err_msg:
                err_msg = (proc.stderr.strip().split("\n")[-1]
                           if proc.stderr else "未知错误（脚本退出码非0且无错误信息）")
            return ScriptResult(False, error=err_msg, stderr=proc.stderr)

        # 解析 stdout JSON
        stdout = proc.stdout.strip()
        if not stdout:
            # 可能输出到了 --out 文件
            return ScriptResult(True, data=[], stderr=proc.stderr)

        try:
            data = json.loads(stdout)
            # 脚本可能输出 {"records": [...]} 或 {"error": "..."} 或 [...]
            if isinstance(data, dict):
                if "error" in data and data["error"]:
                    return ScriptResult(False, error=data["error"], stderr=proc.stderr)
                # requires_crawl 等非记录信号 → 空记录，但保留信号供 acquire 阶段使用
                if data.get("status") in ("requires_crawl", "skipped"):
                    return ScriptResult(True, data=[], stderr=proc.stderr,
                                        signals=data)
                if "records" in data:
                    return ScriptResult(True, data=data["records"], stderr=proc.stderr)
                return ScriptResult(True, data=data, stderr=proc.stderr)
            elif isinstance(data, list):
                return ScriptResult(True, data=data, stderr=proc.stderr)
            else:
                return ScriptResult(True, data=data, stderr=proc.stderr)
        except json.JSONDecodeError:
            # stdout 不是 JSON，可能是错误信息
            last_line = stdout.strip().split("\n")[-1] if stdout else ""
            return ScriptResult(False, error=last_line or "stdout 非 JSON",
                                  stderr=proc.stderr)

    def run_to_file(self, args: list[str], output_file: Path,
                    timeout: int = 120, env: dict | None = None) -> ScriptResult:
        """执行脚本，输出到文件，再读取解析。

        适用于输出较大的场景。优先读取 --out 文件中的完整数据，
        因为脚本常将完整结果写入文件、仅向 stdout 打印摘要或日志到 stderr。
        支持多种输出格式：
        - 数据源: {"records": [...], "count": N}
        - 分析结果: {"status": "ok", "result": {...}, "summary": "..."}
        - 裸列表: [...]
        - 裸字典: {...}
        """
        args = list(args) + ["--out", str(output_file)]
        result = self.run(args, timeout=timeout, env=env)
        # 优先从输出文件读取完整数据（文件中通常含 records 列表或 result 对象）
        if output_file.exists():
            try:
                with open(output_file, "r", encoding="utf-8-sig") as f:
                    file_data = json.load(f)
                # 数据源格式: {"records": [...]}
                if isinstance(file_data, dict) and "records" in file_data:
                    result.data = file_data["records"]
                # 分析结果格式: {"status": "ok", "result": {...}, "summary": "..."}
                elif isinstance(file_data, dict) and "result" in file_data:
                    result.data = file_data["result"]
                # 裸列表
                elif isinstance(file_data, list):
                    result.data = file_data
                # 裸字典（且 stdout 解析结果为空或也是摘要时用文件）
                elif isinstance(file_data, dict) and file_data:
                    if not result.data or (isinstance(result.data, dict)
                                           and "status" in result.data
                                           and "records" not in result.data
                                           and "result" not in result.data):
                        result.data = file_data
            except (json.JSONDecodeError, OSError) as e:
                # 文件读取失败，保留 stdout 解析结果
                if not result.success:
                    return ScriptResult(False, error=f"读取输出文件失败: {e}")
        return result


# ===== 数据源脚本映射 =====
DATASOURCE_SCRIPTS = {
    "pubmed":           ("datasources/pubmed_client.py", "PubMed 文献检索"),
    "openalex":         ("datasources/openalex_client.py", "OpenAlex 学术文献检索"),
    "semantic_scholar": ("datasources/semantic_scholar_client.py", "Semantic Scholar 语义检索"),
    "arxiv":            ("datasources/arxiv_client.py", "arXiv 预印本论文检索"),
    "geo":              ("datasources/geo_client.py", "GEO 基因表达数据集"),
    "string":           ("datasources/string_client.py", "STRING 蛋白互作网络"),
    "kegg":             ("datasources/kegg_client.py", "KEGG 通路数据"),
    "pdb":              ("datasources/pdb_client.py", "PDB 蛋白质结构"),
    "tcmsp":            ("datasources/tcmsp_client.py", "TCMSP 中药化合物"),
    "ncbi":             ("datasources/ncbi_client.py", "NCBI Gene/Protein"),
    "clinicaltrials":   ("datasources/clinicaltrials_client.py", "ClinicalTrials.gov 临床试验"),
    "tcga":             ("datasources/tcga_client.py", "TCGA/GDC 癌症基因组"),
    "drugbank":         ("datasources/drugbank_client.py", "OpenTargets 药物-靶点"),
    "disgenet":         ("datasources/disgenet_client.py", "DisGeNET 基因-疾病"),
    "pubchem":          ("datasources/pubchem_client.py", "PubChem 化合物结构"),
}

# ===== 解析器脚本映射 =====
PARSER_SCRIPTS = {
    "pdf_table":    ("parsers/pdf_table_parser.py", "PDF 表格提取"),
    "pdf_download": ("parsers/pdf_downloader.py", "论文 PDF 下载"),
    "geo_soft":     ("parsers/geo_soft_parser.py", "GEO SOFT 格式解析"),
    "pdb_parser":   ("parsers/pdb_parser.py", "PDB 结构文件解析"),
    "fasta":        ("parsers/fasta_parser.py", "FASTA 序列解析"),
    "network":      ("parsers/network_parser.py", "STRING/SIF/GraphML 网络解析"),
}

# ===== 清洗脚本映射 =====
CLEANER_SCRIPTS = {
    "field_aligner":     ("cleaners/field_aligner.py", "字段对齐"),
    "unit_normalizer":  ("cleaners/unit_normalizer.py", "单位归一化"),
    "duplicate_dedector":("cleaners/duplicate_dedector.py", "重复检测去重"),
}

# ===== 分析脚本映射 =====
ANALYSIS_SCRIPTS = {
    "diff_expr":         ("analysis/differential_expression.py", "差异表达分析"),
    "enrichment":        ("analysis/enrichment.py", "GO/KEGG 富集分析"),
    "ppi_network":       ("analysis/ppi_network.py", "PPI 网络分析"),
    "hub_gene":          ("analysis/hub_gene_analyzer.py", "Hub 基因识别"),
    "upstream_regulator": ("analysis/upstream_regulator.py", "上游调控因子"),
    "drug_target":       ("analysis/drug_target_analyzer.py", "药物-靶点分析"),
    "survival":          ("analysis/survival_analysis.py", "生存分析"),
}

# ===== 导出脚本映射 =====
EXPORT_SCRIPTS = {
    "to_csv":   ("export/to_csv.py", "CSV 导出"),
    "to_excel": ("export/to_excel.py", "Excel 导出"),
    "to_report":("export/to_report.py", "Markdown 报告生成"),
}

# ===== 优化脚本映射 =====
OPTIMIZATION_SCRIPTS = {
    "stage_evaluator":  ("optimization/stage_evaluator.py", "Stage Gate 评估器"),
    "reflection_loop":  ("optimization/reflection_loop.py", "反思循环"),
    "keyword_expander": ("optimization/keyword_expander.py", "关键词扩展"),
}

# ===== 溯源脚本映射 =====
PROVENANCE_SCRIPTS = {
    "tracker": ("provenance/tracker.py", "溯源记录器"),
    "query":   ("provenance/query.py", "溯源查询"),
}

# ===== 可视化脚本映射 =====
VIZ_SCRIPTS = {
    "volcano":         ("viz/volcano_plot.py", "火山图"),
    "enrichment_bubble":("viz/enrichment_bubble.py", "富集气泡图"),
    "heatmap":         ("viz/heatmap.py", "热图"),
    "network_plot":    ("viz/network_plot.py", "网络图"),
    "extract_chart":   ("viz/extract_chart_data.py", "图表数据提取"),
}

# ===== IO 脚本映射 =====
IO_SCRIPTS = {
    "csv_to_json":  ("io/csv_to_json.py", "CSV 转 JSON"),
    "excel_to_json":("io/excel_to_json.py", "Excel 转 JSON"),
    "json_to_csv":  ("io/json_to_csv.py", "JSON 转 CSV"),
    "merge_json":   ("io/merge_json.py", "JSON 合并"),
}


def get_all_script_maps() -> dict[str, dict]:
    """返回所有脚本映射，按类别分组。"""
    return {
        "datasources": DATASOURCE_SCRIPTS,
        "parsers": PARSER_SCRIPTS,
        "cleaners": CLEANER_SCRIPTS,
        "analysis": ANALYSIS_SCRIPTS,
        "export": EXPORT_SCRIPTS,
        "optimization": OPTIMIZATION_SCRIPTS,
        "provenance": PROVENANCE_SCRIPTS,
        "viz": VIZ_SCRIPTS,
        "io": IO_SCRIPTS,
    }
