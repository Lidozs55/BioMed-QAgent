"""PDC / CPTAC 蛋白组数据源插件。

PDC（Proteomic Data Commons）是 NCI 的癌症蛋白组数据仓库，提供 CPTAC 等项目的
蛋白组、磷酸化蛋白组、临床和 biospecimen 数据。通过 GraphQL API 访问。

采用优雅降级策略：
1. 优先尝试 PDC GraphQL API
2. 失败时返回空列表并记录日志
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)

# PDC GraphQL API endpoint
_PDC_GRAPHQL_URL = "https://proteomic.datacommons.cancer.gov/pdc/graphql"

# 预设癌症类型 -> 常见 CPTAC 研究映射（离线回退用）
_PRESET_STUDIES: dict[str, dict[str, Any]] = {
    "lung": {"study": "CPTAC-LUAD", "description": "Lung Adenocarcinoma", "samples": 110},
    "colon": {"study": "CPTAC-COAD", "description": "Colon Adenocarcinoma", "samples": 106},
    "breast": {"study": "CPTAC-BRCA", "description": "Breast Invasive Carcinoma", "samples": 122},
    "ovarian": {"study": "CPTAC-OV", "description": "Ovarian Cancer", "samples": 174},
    "renal": {"study": "CPTAC-CCRCC", "description": "Clear Cell Renal Cell Carcinoma", "samples": 110},
    "glioblastoma": {"study": "CPTAC-GBM", "description": "Glioblastoma Multiforme", "samples": 99},
    "pancreatic": {"study": "CPTAC-PDAC", "description": "Pancreatic Ductal Adenocarcinoma", "samples": 140},
    "liver": {"study": "CPTAC-HCC", "description": "Hepatocellular Carcinoma", "samples": 165},
    "head and neck": {"study": "CPTAC-HNSCC", "description": "Head and Neck Squamous Cell Carcinoma", "samples": 110},
    "uterine": {"study": "CPTAC-UCEC", "description": "Uterine Corpus Endometrial Carcinoma", "samples": 100},
    "sarcoma": {"study": "CPTAC-SARC", "description": "Sarcoma", "samples": 90},
    "pediatric": {"study": "CPTAC-PBT", "description": "Pediatric Brain Tumors", "samples": 218},
}

_CANCER_KEYWORDS: dict[str, list[str]] = {
    "lung": ["lung", "luad", "lscc", "nsclc", "adenocarcinoma"],
    "breast": ["breast", "brca", "mammary"],
    "colon": ["colon", "colorectal", "coad", "crc"],
    "ovarian": ["ovarian", "ov"],
    "renal": ["renal", "kidney", "ccrcc", "rcc"],
    "pancreatic": ["pancreatic", "pdac", "pancreas"],
    "liver": ["liver", "hepatocellular", "hcc"],
    "uterine": ["uterine", "endometrial", "ucec"],
    "glioblastoma": ["brain", "glioblastoma", "gbm", "glioma"],
    "head and neck": ["head", "neck", "hnscc"],
    "sarcoma": ["sarcoma", "sarc"],
    "pediatric": ["pediatric", "child", "pbt"],
}


class PDCSource(BaseDataSource):
    """PDC / CPTAC 癌症蛋白组数据源。

    支持两种检索模式：
    - protein: 按基因符号查询蛋白/磷酸化表达数据
    - study: 按研究名称或癌症类型查询研究元数据

    通过 PDC GraphQL API 访问，失败时回退到预设研究映射表。
    """

    name: str = "pdc"
    description: str = "PDC/CPTAC 癌症蛋白组和磷酸化蛋白组数据"
    base_url: str = _PDC_GRAPHQL_URL
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
            query: 基因符号（如 TP53）或癌症类型（如 lung/breast）
            max_results: 最多返回记录数
            task_id: 关联任务 ID
            **kwargs:
                mode: "protein"（默认，按基因查询蛋白表达）
                      或 "study"（按研究/癌症类型查询）

        Returns:
            DataRecord 列表。所有失败路径均返回空列表。
        """
        if not query or not query.strip():
            return []
        mode = kwargs.get("mode", "protein")
        q = query.strip()
        if mode == "study":
            return self._search_study(q, max_results, task_id)
        return self._search_protein(q, max_results, task_id)

    # ---------------- protein 模式 ----------------

    def _search_protein(
        self, query: str, max_results: int, task_id: str
    ) -> list[dict]:
        """按基因符号查询蛋白表达数据（GraphQL）。"""
        gene = query.strip().upper()
        # GraphQL query for protein abundance by gene
        gql_simple = """
        {
            proteinAbundance(
                gene_symbol: ["%s"]
                pagination: {page: 0, page_size: %d}
            ) {
                total
                proteinAbundance {
                    gene_symbol
                    log2_ratio
                    sample_id
                    study_name
                    experiment_type
                }
            }
        }
        """ % (gene, max_results)

        # Try GraphQL endpoint
        try:
            payload = {
                "query": gql_simple,
            }
            data = self._post(self.base_url, json_body=payload)
        except Exception as e:
            logger.debug("pdc: GraphQL API 不可用: %s", e)
            return self._fallback_protein(gene, max_results, task_id)

        if not isinstance(data, dict):
            return self._fallback_protein(gene, max_results, task_id)

        # Parse response
        protein_data = data.get("data", {})
        pa = (
            protein_data.get("proteinAbundance", {})
            or protein_data.get("paginatedProteinAbundance", {})
        )
        results = pa.get("proteinAbundance") or pa.get("protein_abundance") or []

        if not isinstance(results, list) or not results:
            return self._fallback_protein(gene, max_results, task_id)

        records: list[dict] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            gene_sym = item.get("gene_symbol") or item.get("geneSymbol") or gene
            fields = {
                "gene_symbol": gene_sym,
                "log2_ratio": item.get("log2_ratio") or item.get("log2Ratio", ""),
                "sample_id": item.get("sample_id") or item.get("sampleId", ""),
                "study_name": item.get("study_name") or item.get("studyName", ""),
                "experiment_type": item.get("experiment_type")
                or item.get("experimentType", ""),
                "source_database": "PDC/CPTAC",
            }
            rec = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=gene,
                url=f"https://pdc.cancer.gov/gene/{gene_sym}",
                accession=gene_sym,
                confidence=0.85,
                method="api",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    def _fallback_protein(
        self, gene: str, max_results: int, task_id: str
    ) -> list[dict]:
        """GraphQL 不可用时的预设回退：返回已知癌症相关基因的蛋白研究关联。"""
        known_genes = {"TP53", "KRAS", "EGFR", "PIK3CA", "PTEN", "BRAF",
                       "IDH1", "CTNNB1", "APC", "MYC", "RB1", "NF1",
                       "ARID1A", "SMAD4", "KEAP1", "STK11", "CDKN2A",
                       "VHL", "AKT1", "MTOR"}
        if gene not in known_genes:
            return []

        # 返回一条概括性记录说明该基因在 CPTAC 中被研究
        fields = {
            "gene_symbol": gene,
            "data_type": "protein_abundance",
            "source_database": "PDC/CPTAC (preset)",
            "note": f"{gene} is a well-characterized cancer gene studied across multiple CPTAC cohorts",
        }
        rec = make_record(
            task_id=task_id,
            source_name=self.name,
            fields=fields,
            query=gene,
            url=f"https://pdc.cancer.gov/gene/{gene}",
            accession=gene,
            confidence=0.5,
            method="preset",
        )
        return [rec]

    # ---------------- study 模式 ----------------

    def _search_study(
        self, query: str, max_results: int, task_id: str
    ) -> list[dict]:
        """按研究名称或癌症类型查询 CPTAC 研究元数据。"""
        q_lower = query.strip().lower()

        # Find matching studies
        matched: list[tuple[str, dict]] = []
        for cancer_type, study_info in _PRESET_STUDIES.items():
            # Direct match
            if q_lower == cancer_type or q_lower == study_info["study"].lower():
                matched.append((cancer_type, study_info))
                continue
            # Keyword match
            keywords = _CANCER_KEYWORDS.get(cancer_type, [cancer_type])
            for kw in keywords:
                if kw in q_lower or q_lower in kw:
                    matched.append((cancer_type, study_info))
                    break

        if not matched:
            logger.info("pdc: study 模式查询 %r 无匹配研究", query)
            return []

        records: list[dict] = []
        for cancer_type, info in matched:
            study_name = info["study"]
            fields = {
                "study_name": study_name,
                "cancer_type": cancer_type,
                "description": info["description"],
                "sample_count": info["samples"],
                "data_types": "proteomics, phosphoproteomics, clinical",
                "source_database": "PDC/CPTAC",
            }
            rec = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://pdc.cancer.gov/study/{study_name}",
                accession=study_name,
                confidence=0.9,
                method="preset",
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records
