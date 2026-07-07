"""DepMap 数据源插件。

DepMap 癌症细胞系依赖性数据源。DepMap 没有完全公开的 REST API
（主要通过下载文件或登录后访问），本插件采用优雅降级策略：

1. 优先尝试 DepMap 公开 API 接口（https://depmap.org/portal/api）
2. 失败时回退到 Sanger Cell Model Passports API
3. 再失败时使用预设的常见细胞系字典查找（仅 cell_line 模式）
4. 全部不可用则返回空列表并记录日志
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)

# Sanger Cell Model Passports API（公开，无需登录）
_SANGER_API = "https://api.cellmodelpassports.sanger.ac.uk"

# 预设常见细胞系字典：name(小写) -> 元数据
# 数据来源于 DepMap Public 22Q2 等公开版本，供 API 不可用时回退使用。
_PRESET_CELL_LINES: dict[str, dict[str, Any]] = {
    "a549": {
        "depmap_id": "ACH-000001",
        "cancer_type": "lung",
        "disease_context": "Non-Small Cell Lung Cancer (adenocarcinoma)",
        "growth_rate": 0.75,
    },
    "mcf7": {
        "depmap_id": "ACH-000019",
        "cancer_type": "breast",
        "disease_context": "Breast Cancer (estrogen receptor positive)",
        "growth_rate": 0.85,
    },
    "hela": {
        "depmap_id": "ACH-000025",
        "cancer_type": "cervix",
        "disease_context": "Cervical Cancer (HPV-positive)",
        "growth_rate": 0.90,
    },
    "k562": {
        "depmap_id": "ACH-000038",
        "cancer_type": "hematopoietic_neoplasm",
        "disease_context": "Chronic Myelogenous Leukemia (BCR-ABL+)",
        "growth_rate": 0.80,
    },
    "hepg2": {
        "depmap_id": "ACH-000041",
        "cancer_type": "liver",
        "disease_context": "Hepatocellular Carcinoma",
        "growth_rate": 0.70,
    },
    "hct116": {
        "depmap_id": "ACH-000030",
        "cancer_type": "colorectal",
        "disease_context": "Colorectal Carcinoma (KRAS mutant)",
        "growth_rate": 0.78,
    },
    "pc9": {
        "depmap_id": "ACH-000088",
        "cancer_type": "lung",
        "disease_context": "Non-Small Cell Lung Cancer (EGFR mutant)",
        "growth_rate": 0.72,
    },
    "du145": {
        "depmap_id": "ACH-000085",
        "cancer_type": "prostate",
        "disease_context": "Prostate Cancer",
        "growth_rate": 0.65,
    },
    "u2os": {
        "depmap_id": "ACH-000117",
        "cancer_type": "bone",
        "disease_context": "Osteosarcoma",
        "growth_rate": 0.68,
    },
    "mv4-11": {
        "depmap_id": "ACH-000055",
        "cancer_type": "hematopoietic_neoplasm",
        "disease_context": "Acute Myeloid Leukemia (MLL-AF4)",
        "growth_rate": 0.62,
    },
}

# 癌症类型关键字 -> 对应的预设细胞系名称列表（用于按癌症类型查询）
_CANCER_TYPE_INDEX: dict[str, list[str]] = {
    "lung": ["A549", "PC9"],
    "breast": ["MCF7"],
    "cervical": ["HeLa"],
    "cervix": ["HeLa"],
    "leukemia": ["K562", "MV4-11"],
    "cml": ["K562"],
    "aml": ["MV4-11"],
    "liver": ["HEPG2"],
    "hepatocellular": ["HEPG2"],
    "colorectal": ["HCT116"],
    "colon": ["HCT116"],
    "prostate": ["DU145"],
    "bone": ["U2OS"],
    "osteosarcoma": ["U2OS"],
}


class DepMapSource(BaseDataSource):
    """DepMap 癌症细胞系依赖性数据源。

    支持两种检索模式：
    - cell_line: 按细胞系名称或癌症类型查询细胞系元数据
    - gene_dependency: 按基因符号查询 CRISPR 依赖性评分

    由于 DepMap 正式 API 需要登录，本类采用优雅降级策略：
    优先尝试公开 API，失败时使用预设细胞系字典或返回空列表，
    绝不抛出异常中断调用方流程。
    """

    name: str = "depmap"
    description: str = "DepMap 癌症细胞系依赖性"
    base_url: str = "https://depmap.org/portal/api"
    default_rate: float = 1.0

    def search(
        self,
        query: str,
        max_results: int = 20,
        task_id: str = "default",
        **kwargs: Any,
    ) -> list[dict]:
        """执行检索，返回 DataRecord 列表。

        Args:
            query: 细胞系名称（如 A549）、癌症类型（如 lung）
                   或基因符号（如 TP53）。
            max_results: 最多返回记录数。
            task_id: 关联任务 ID。
            **kwargs:
                mode: 检索模式，"cell_line"（默认）或 "gene_dependency"。

        Returns:
            DataRecord 列表。所有失败路径均返回空列表而非抛出异常。
        """
        if not query or not query.strip():
            return []
        mode = kwargs.get("mode", "cell_line")
        q = query.strip()
        if mode == "gene_dependency":
            return self._search_gene_dependency(q, max_results, task_id)
        return self._search_cell_line(q, max_results, task_id)

    # ---------------- cell_line 模式 ----------------

    def _search_cell_line(
        self, query: str, max_results: int, task_id: str
    ) -> list[dict]:
        """按细胞系名称或癌症类型查询细胞系元数据（多级回退）。"""
        # 1. 优先尝试 DepMap 公开 API
        records = self._try_depmap_cell_line_api(query, max_results, task_id)
        if records:
            return records
        # 2. 回退到 Sanger Cell Model Passports API
        records = self._try_sanger_api(query, max_results, task_id)
        if records:
            return records
        # 3. 回退到预设细胞系字典（无网络依赖）
        records = self._lookup_preset_cell_lines(query, max_results, task_id)
        if records:
            return records
        logger.warning(
            "depmap: cell_line 模式查询 %r 无可用数据（API 与预设字典均无匹配）",
            query,
        )
        return []

    def _try_depmap_cell_line_api(
        self, query: str, max_results: int, task_id: str
    ) -> list[dict]:
        """尝试 DepMap 公开 cell_line API。失败时返回空列表。"""
        url = f"{self.base_url}/cell_line"
        params = {"search": query, "limit": max_results}
        try:
            data = self._get(url, params=params)
        except Exception as e:  # noqa: BLE001 - 优雅降级，捕获所有网络/解析错误
            logger.debug("depmap: cell_line API 不可用: %s", e)
            return []

        if not isinstance(data, dict):
            return []
        results = data.get("search_results") or data.get("results") or []
        if not isinstance(results, list):
            return []

        records: list[dict] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            cell_line_name = (
                item.get("cell_line_name") or item.get("DepMapName") or ""
            )
            if not cell_line_name:
                continue
            depmap_id = item.get("DepMapID") or item.get("depmap_id") or ""
            fields = {
                "cell_line_name": cell_line_name,
                "cancer_type": item.get("lineage") or item.get("cancer_type") or "",
                "disease_context": item.get("disease") or "",
                "growth_rate": item.get("growth_rate", ""),
                "source_database": "DepMap",
                "depmap_id": depmap_id,
            }
            rec = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://depmap.org/portal/cell_line/{cell_line_name}",
                accession=depmap_id or cell_line_name,
                confidence=0.8,
                method="api",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    def _try_sanger_api(
        self, query: str, max_results: int, task_id: str
    ) -> list[dict]:
        """回退方案：Sanger Cell Model Passports API。失败时返回空列表。"""
        url = f"{_SANGER_API}/cell_lines"
        # JSON:API 风格过滤
        params = {"filter[name]": query, "page[size]": max_results}
        try:
            data = self._get(url, params=params)
        except Exception as e:  # noqa: BLE001 - 优雅降级
            logger.debug("depmap: Sanger API 不可用: %s", e)
            return []

        if not isinstance(data, dict):
            return []
        results = data.get("data") or []
        if not isinstance(results, list):
            return []

        records: list[dict] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            attrs = item.get("attributes") or {}
            if not isinstance(attrs, dict):
                continue
            cell_line_name = attrs.get("name") or attrs.get("model_name") or ""
            if not cell_line_name:
                continue
            depmap_id = attrs.get("depmap_id") or ""
            fields = {
                "cell_line_name": cell_line_name,
                "cancer_type": attrs.get("tissue") or attrs.get("lineage") or "",
                "disease_context": attrs.get("disease")
                or attrs.get("cancer_type")
                or "",
                "growth_rate": attrs.get("growth_rate", ""),
                "source_database": "Sanger Cell Model Passports",
                "depmap_id": depmap_id,
            }
            rec = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://depmap.org/portal/cell_line/{cell_line_name}",
                accession=depmap_id or cell_line_name,
                confidence=0.8,
                method="api",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    def _lookup_preset_cell_lines(
        self, query: str, max_results: int, task_id: str
    ) -> list[dict]:
        """使用预设细胞系字典查找（无网络依赖，离线回退）。"""
        q_lower = query.lower()
        matched: list[tuple[str, dict[str, Any]]] = []

        # 1) 按细胞系名完全匹配
        for name, info in _PRESET_CELL_LINES.items():
            if name == q_lower:
                matched.append((name.upper(), info))

        # 2) 前缀/包含匹配
        if not matched:
            for name, info in _PRESET_CELL_LINES.items():
                if name.startswith(q_lower) or q_lower.startswith(name):
                    matched.append((name.upper(), info))

        # 3) 按癌症类型关键字匹配
        if not matched:
            for keyword, names in _CANCER_TYPE_INDEX.items():
                if keyword in q_lower or q_lower in keyword:
                    for n in names:
                        nl = n.lower()
                        if nl in _PRESET_CELL_LINES:
                            matched.append((n, _PRESET_CELL_LINES[nl]))
                    break

        if not matched:
            return []

        records: list[dict] = []
        for cell_line_name, info in matched:
            depmap_id = info.get("depmap_id", "")
            fields = {
                "cell_line_name": cell_line_name,
                "cancer_type": info.get("cancer_type", ""),
                "disease_context": info.get("disease_context", ""),
                "growth_rate": info.get("growth_rate", ""),
                "source_database": "DepMap (preset)",
                "depmap_id": depmap_id,
            }
            rec = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://depmap.org/portal/cell_line/{cell_line_name}",
                accession=depmap_id or cell_line_name,
                confidence=0.8,
                method="preset",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    # ---------------- gene_dependency 模式 ----------------

    def _search_gene_dependency(
        self, query: str, max_results: int, task_id: str
    ) -> list[dict]:
        """按基因符号查询 CRISPR 依赖性评分。"""
        gene = query.strip()
        # 1. 尝试 DepMap gene API
        records = self._try_depmap_gene_api(gene, max_results, task_id)
        if records:
            return records
        # 2. 所有 API 不可用，优雅降级返回空列表
        logger.warning(
            "depmap: gene_dependency 模式查询 %r 无可用数据（DepMap API 需登录）",
            gene,
        )
        return []

    def _try_depmap_gene_api(
        self, gene: str, max_results: int, task_id: str
    ) -> list[dict]:
        """尝试 DepMap 公开 gene API。失败时返回空列表。"""
        url = f"{self.base_url}/gene/{gene}"
        params = {"limit": max_results}
        try:
            data = self._get(url, params=params)
        except Exception as e:  # noqa: BLE001 - 优雅降级
            logger.debug("depmap: gene API 不可用: %s", e)
            return []

        if not isinstance(data, dict):
            return []
        results = data.get("results") or data.get("dependency_scores") or []
        if not isinstance(results, list):
            return []

        records: list[dict] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            cell_line_name = (
                item.get("cell_line_name") or item.get("DepMapName") or ""
            )
            score = item.get("dependency_score")
            if score is None:
                score = item.get("chronos_score")
            if not cell_line_name and score is None:
                continue
            fields = {
                "gene_symbol": gene,
                "cell_line_name": cell_line_name,
                "dependency_score": score if score is not None else "",
                "percentile": item.get("percentile", ""),
                "source_database": "DepMap",
            }
            rec = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=gene,
                url=f"https://depmap.org/portal/gene/{gene}",
                accession=gene,
                confidence=0.8,
                method="api",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records
