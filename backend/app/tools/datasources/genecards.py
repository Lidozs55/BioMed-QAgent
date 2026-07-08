"""GeneCards 基因中心整合知识数据源插件。

GeneCards 提供基因符号、别名、功能描述、基因组位置、关联疾病等
整合信息，数据来源于 150+ 数据库。

⚠️ GeneCards 禁止网页抓取。本插件仅使用预设数据；
   若提供授权 API key，则通过授权接口查询。
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)

# 预设 15 个核心癌症/遗传病基因的关键摘要信息
_PRESET_GENE_INFO: dict[str, dict[str, Any]] = {
    "TP53": {
        "aliases": ["P53", "TRP53"],
        "function": "Tumor suppressor, cell cycle arrest, apoptosis",
        "location": "17p13.1",
        "diseases": ["Li-Fraumeni", "Multiple cancers"],
    },
    "EGFR": {
        "aliases": ["ERBB1", "HER1"],
        "function": "Receptor tyrosine kinase, cell proliferation",
        "location": "7p11.2",
        "diseases": ["NSCLC", "Glioblastoma"],
    },
    "KRAS": {
        "aliases": ["KRAS2"],
        "function": "GTPase, MAPK signaling",
        "location": "12p12.1",
        "diseases": ["Pancreatic", "Colorectal", "Lung cancers"],
    },
    "BRCA1": {
        "aliases": ["BRCC1"],
        "function": "DNA repair, homologous recombination",
        "location": "17q21.31",
        "diseases": ["Breast", "Ovarian cancers"],
    },
    "BRAF": {
        "aliases": ["BRAF1", "RAF1"],
        "function": "Serine/threonine kinase, MAPK pathway",
        "location": "7q34",
        "diseases": ["Melanoma", "Thyroid cancer"],
    },
    "PTEN": {
        "aliases": ["MMAC1", "TEP1"],
        "function": "Phosphatase, PI3K/AKT pathway suppressor",
        "location": "10q23.31",
        "diseases": ["Cowden syndrome", "Prostate cancer"],
    },
    "ALK": {
        "aliases": ["CD246"],
        "function": "Receptor tyrosine kinase, neuronal development",
        "location": "2p23.2",
        "diseases": ["NSCLC", "Neuroblastoma", "ALCL"],
    },
    "PIK3CA": {
        "aliases": ["PI3K"],
        "function": "Catalytic subunit of PI3K, cell growth",
        "location": "3q26.32",
        "diseases": ["Breast", "Colorectal cancers"],
    },
    "IDH1": {
        "aliases": ["IDH"],
        "function": "Isocitrate dehydrogenase, NADPH production",
        "location": "2q34",
        "diseases": ["Glioma", "AML"],
    },
    "MYC": {
        "aliases": ["c-Myc", "MRTL"],
        "function": "Transcription factor, cell cycle progression",
        "location": "8q24.21",
        "diseases": ["Burkitt lymphoma", "Multiple cancers"],
    },
    "MTOR": {
        "aliases": ["FRAP", "RAFT1"],
        "function": "Serine/threonine kinase, cell growth regulation",
        "location": "1p36.22",
        "diseases": ["Multiple cancers"],
    },
    "BCL2": {
        "aliases": ["Bcl-2"],
        "function": "Anti-apoptotic protein, mitochondrial regulation",
        "location": "18q21.33",
        "diseases": ["Follicular lymphoma", "CLL"],
    },
    "VEGFA": {
        "aliases": ["VEGF"],
        "function": "Angiogenesis factor",
        "location": "6p21.1",
        "diseases": ["Multiple solid tumors"],
    },
    "CDKN2A": {
        "aliases": ["p16", "INK4a"],
        "function": "Cyclin-dependent kinase inhibitor",
        "location": "9p21.3",
        "diseases": ["Familial melanoma", "Pancreatic cancer"],
    },
    "ERBB2": {
        "aliases": ["HER2", "NEU"],
        "function": "Receptor tyrosine kinase, cell growth",
        "location": "17q12",
        "diseases": ["Breast cancer", "Gastric cancer"],
    },
}


class GeneCardsSource(BaseDataSource):
    """GeneCards 基因中心整合知识数据源（受控访问，禁止爬虫）。

    按基因符号查询整合基因信息：别名、功能、基因组位置、关联疾病。

    ⚠️ GeneCards 禁止网页抓取。若无授权 API key，仅使用预设数据。
    """

    name: str = "genecards"
    description: str = "GeneCards gene-centric integrative knowledge (controlled access, no scraping)"
    base_url: str = "https://www.genecards.org"
    default_rate: float = 1.0

    def search(
        self,
        query: str,
        max_results: int = 20,
        task_id: str = "default",
        **kwargs: Any,
    ) -> list[dict]:
        """执行检索。

        Args:
            query: 基因符号（如 TP53）
            max_results: 最多返回记录数
            task_id: 关联任务 ID
            **kwargs:
                api_key: GeneCards 授权 API key（可选）

        Returns:
            DataRecord 列表。
        """
        if not query or not query.strip():
            return []
        api_key = kwargs.get("api_key", "")
        gene = query.strip().upper()

        # 仅通过授权 API 查询；禁止网页抓取
        if api_key:
            records = self._try_genecards_api(gene, max_results, task_id, api_key)
            if records:
                return records

        # Fallback: 预设数据
        return self._lookup_preset(gene, max_results, task_id)

    def _try_genecards_api(
        self, gene: str, max_results: int, task_id: str, api_key: str
    ) -> list[dict]:
        """尝试 GeneCards 授权 API 查询。"""
        url = f"{self.base_url}/api/gene/{gene}"
        headers = {"Authorization": f"Bearer {api_key}"}
        try:
            data = self._get(url, headers=headers)
        except Exception as e:
            logger.debug("genecards: GeneCards API 不可用: %s", e)
            return []

        if not isinstance(data, dict):
            return []

        fields = {
            "gene_symbol": gene,
            "aliases": data.get("aliases", []) or [],
            "function": data.get("function", "") or "",
            "location": data.get("location", "") or "",
            "diseases": data.get("diseases", []) or [],
            "source_database": "GeneCards",
        }
        rec = make_record(
            task_id=task_id,
            source_name=self.name,
            fields=fields,
            query=gene,
            url=f"https://www.genecards.org/cgi-bin/carddisp.pl?gene={gene}",
            accession=gene,
            confidence=0.85,
            method="api",
        )
        return [rec]

    def _lookup_preset(
        self, gene: str, max_results: int, task_id: str
    ) -> list[dict]:
        """从预设数据库查询基因摘要信息。"""
        info = _PRESET_GENE_INFO.get(gene, {})
        if not info:
            logger.info("genecards: gene %s 无预设数据", gene)
            return []

        fields = {
            "gene_symbol": gene,
            "aliases": info.get("aliases", []),
            "function": info.get("function", ""),
            "location": info.get("location", ""),
            "diseases": info.get("diseases", []),
            "source_database": "GeneCards (preset)",
        }
        rec = make_record(
            task_id=task_id,
            source_name=self.name,
            fields=fields,
            query=gene,
            url=f"https://www.genecards.org/cgi-bin/carddisp.pl?gene={gene}",
            accession=gene,
            confidence=0.75,
            method="preset",
        )
        return [rec] if max_results > 0 else []
