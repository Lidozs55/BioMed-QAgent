"""OMIM 孟德尔遗传表型/基因-表型关联数据源插件。

OMIM (Online Mendelian Inheritance in Man) 提供基因-表型/疾病关联关系、
遗传模式、临床描述等权威信息。

采用优雅降级策略：
1. 优先尝试 OMIM API（需 API key）
2. 失败时使用预设的已知基因-表型关联数据
3. 全部不可用则返回空列表
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)

# OMIM API endpoint
_OMIM_API = "https://api.omim.org/api"

# 预设已知基因-表型/疾病关联数据（15+ 知名癌症/遗传病基因）
_PRESET_GENE_PHENOTYPES: dict[str, list[dict[str, Any]]] = {
    "TP53": [
        {"disease": "Li-Fraumeni syndrome", "omim_id": "151623", "inheritance": "AD"},
        {"disease": "Adrenocortical carcinoma, somatic", "omim_id": "202300", "inheritance": "Somatic"},
        {"disease": "Breast cancer, somatic", "omim_id": "114480", "inheritance": "Somatic"},
    ],
    "BRCA1": [
        {"disease": "Breast-ovarian cancer, familial 1", "omim_id": "604370", "inheritance": "AD"},
        {"disease": "Pancreatic cancer, susceptibility to", "omim_id": "614320", "inheritance": "AD"},
    ],
    "BRCA2": [
        {"disease": "Breast cancer, early-onset", "omim_id": "600185", "inheritance": "AD"},
        {"disease": "Fanconi anemia, complementation group D1", "omim_id": "605724", "inheritance": "AR"},
    ],
    "EGFR": [
        {"disease": "Lung cancer, somatic", "omim_id": "211980", "inheritance": "Somatic"},
        {"disease": "Adenocarcinoma of lung, somatic", "omim_id": "211980", "inheritance": "Somatic"},
    ],
    "KRAS": [
        {"disease": "Pancreatic cancer, somatic", "omim_id": "260350", "inheritance": "Somatic"},
        {"disease": "Noonan syndrome 3", "omim_id": "609942", "inheritance": "AD"},
        {"disease": "Cardiofaciocutaneous syndrome 2", "omim_id": "615278", "inheritance": "AD"},
    ],
    "BRAF": [
        {"disease": "Melanoma, somatic", "omim_id": "155600", "inheritance": "Somatic"},
        {"disease": "Noonan syndrome 7", "omim_id": "613706", "inheritance": "AD"},
        {"disease": "Cardiofaciocutaneous syndrome 1", "omim_id": "115150", "inheritance": "AD"},
    ],
    "PTEN": [
        {"disease": "Cowden syndrome", "omim_id": "158350", "inheritance": "AD"},
        {"disease": "PTEN hamartoma tumor syndrome", "omim_id": "601728", "inheritance": "AD"},
    ],
    "RET": [
        {"disease": "MEN2A", "omim_id": "171400", "inheritance": "AD"},
        {"disease": "MEN2B", "omim_id": "162300", "inheritance": "AD"},
        {"disease": "Hirschsprung disease 1", "omim_id": "142623", "inheritance": "AD"},
    ],
    "APC": [
        {"disease": "Familial adenomatous polyposis", "omim_id": "175100", "inheritance": "AD"},
        {"disease": "Colorectal cancer", "omim_id": "114500", "inheritance": "AD"},
    ],
    "MLH1": [
        {"disease": "Lynch syndrome", "omim_id": "120435", "inheritance": "AD"},
        {"disease": "Colorectal cancer, hereditary nonpolyposis, type 2", "omim_id": "609310", "inheritance": "AD"},
    ],
    "NF1": [
        {"disease": "Neurofibromatosis type 1", "omim_id": "162200", "inheritance": "AD"},
        {"disease": "Neurofibromatosis-Noonan syndrome", "omim_id": "601321", "inheritance": "AD"},
    ],
    "RB1": [
        {"disease": "Retinoblastoma", "omim_id": "180200", "inheritance": "AD"},
        {"disease": "Bladder cancer, somatic", "omim_id": "109800", "inheritance": "Somatic"},
    ],
    "VHL": [
        {"disease": "von Hippel-Lindau syndrome", "omim_id": "193300", "inheritance": "AD"},
        {"disease": "Pheochromocytoma", "omim_id": "171300", "inheritance": "AD"},
    ],
    "MSH2": [
        {"disease": "Lynch syndrome", "omim_id": "609309", "inheritance": "AD"},
        {"disease": "Muir-Torre syndrome", "omim_id": "158320", "inheritance": "AD"},
    ],
    "CDKN2A": [
        {"disease": "Familial melanoma", "omim_id": "606719", "inheritance": "AD"},
        {"disease": "Pancreatic cancer, susceptibility to", "omim_id": "606719", "inheritance": "AD"},
    ],
}


class OMIMSource(BaseDataSource):
    """OMIM 孟德尔遗传表型/基因-表型关联数据源。

    通过基因符号或疾病名称查询 OMIM 条目，返回：
    - 疾病/表型名称与 OMIM ID
    - 遗传模式（AD/AR/X-linked/Somatic）
    - 基因-表型关联关系

    OMIM API 需要 API key。无 API key 时使用预设数据库。
    """

    name: str = "omim"
    description: str = "OMIM Mendelian phenotype/gene-phenotype associations (controlled access)"
    base_url: str = _OMIM_API
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
            query: 基因符号（如 TP53）或疾病/表型名称
            max_results: 最多返回记录数
            task_id: 关联任务 ID
            **kwargs:
                api_key: OMIM API key（可选，用于在线查询）

        Returns:
            DataRecord 列表。
        """
        if not query or not query.strip():
            return []
        api_key = kwargs.get("api_key", "")
        q = query.strip().upper()

        # Try OMIM API if key available
        if api_key:
            records = self._try_omim_api(q, max_results, task_id, api_key)
            if records:
                return records

        # Fallback: look up in preset database
        return self._lookup_preset_phenotypes(q, max_results, task_id)

    def _try_omim_api(
        self, query: str, max_results: int, task_id: str, api_key: str
    ) -> list[dict]:
        """尝试 OMIM API 查询。"""
        url = f"{self.base_url}/entry/search"
        params = {
            "search": query,
            "include": "geneMap",
            "limit": max_results,
            "format": "json",
        }
        headers = {"ApiKey": api_key}
        try:
            data = self._get(url, params=params, headers=headers)
        except Exception as e:
            logger.debug("omim: OMIM API 不可用: %s", e)
            return []

        if not isinstance(data, dict):
            return []

        entries = (
            data.get("omim", {}).get("searchResponse", {}).get("entryList", [])
            or []
        )
        if not entries:
            return []

        records: list[dict] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            mim_number = str(entry.get("mimNumber", "") or "")
            fields = {
                "omim_id": mim_number,
                "disease": entry.get("title", "") or "",
                "gene_symbol": query,
                "source_database": "OMIM",
            }
            rec = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://omim.org/entry/{mim_number}",
                accession=mim_number,
                confidence=0.85,
                method="api",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    def _lookup_preset_phenotypes(
        self, query: str, max_results: int, task_id: str
    ) -> list[dict]:
        """从预设数据库查询基因-表型关联。"""
        phenotypes = _PRESET_GENE_PHENOTYPES.get(query, [])
        if not phenotypes:
            logger.info("omim: gene %s 无预设表型数据", query)
            return []

        records: list[dict] = []
        for pheno in phenotypes:
            fields = {
                "gene_symbol": query,
                "disease": pheno["disease"],
                "omim_id": pheno["omim_id"],
                "inheritance": pheno["inheritance"],
                "source_database": "OMIM (preset)",
            }
            rec = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://omim.org/entry/{pheno['omim_id']}",
                accession=pheno["omim_id"],
                confidence=0.80,
                method="preset",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records
