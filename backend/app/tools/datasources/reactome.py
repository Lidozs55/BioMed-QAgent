"""Reactome 数据源插件。

通过 Reactome Analysis Service 对基因列表进行通路富集分析。
API: https://reactome.org/AnalysisService
"""
from __future__ import annotations

import json
import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class ReactomeSource(BaseDataSource):
    """Reactome 通路富集分析数据源。

    接收一组基因符号（逗号分隔或单个），调用 Reactome Analysis
    Service 的 /identifiers/form 端点进行 over-representation 分析，
    返回显著富集的通路列表。
    """

    name: str = "reactome"
    description: str = "Reactome 通路富集分析"
    base_url: str = "https://reactome.org/AnalysisService"
    default_rate: float = 1.0

    def _parse_genes(self, query: str) -> list[str]:
        """将逗号分隔的基因符号字符串解析为基因列表。"""
        if not query:
            return []
        return [g.strip() for g in query.split(",") if g.strip()]

    def _extract_input_genes(
        self, entities: dict, fallback: list[str]
    ) -> list[str]:
        """从 entities.inputEntities 提取命中该通路的输入基因符号。

        优先使用 entities.inputEntities（每项含 ident 字段）；
        若不存在则尝试 entities.resource（兼容列表形态）；
        最终回退到原始提交基因列表。
        """
        if not isinstance(entities, dict):
            return fallback
        genes: list[str] = []
        input_entities = entities.get("inputEntities") or []
        if isinstance(input_entities, list):
            for ie in input_entities:
                if isinstance(ie, dict):
                    ident = ie.get("ident") or ie.get("identifier") or ""
                    if ident:
                        genes.append(str(ident))
                elif isinstance(ie, str) and ie:
                    genes.append(ie)
        if not genes:
            resource = entities.get("resource")
            if isinstance(resource, list):
                for r in resource:
                    if isinstance(r, str) and r:
                        genes.append(r)
                    elif isinstance(r, dict):
                        ident = (
                            r.get("ident")
                            or r.get("identifier")
                            or r.get("name")
                            or ""
                        )
                        if ident:
                            genes.append(str(ident))
        if not genes:
            return fallback
        return genes

    def _extract_species(self, path: dict) -> str:
        """提取物种名称，兼容字符串与列表两种形态。"""
        species = path.get("species", "")
        if isinstance(species, list):
            return ", ".join(str(s) for s in species if s)
        if species:
            return str(species)
        return ""

    def search(
        self,
        query: str,
        max_results: int = 20,
        task_id: str = "default",
        **kwargs: Any,
    ) -> list[dict]:
        """执行 Reactome 通路富集分析。

        Args:
            query: 基因符号列表（逗号分隔字符串，如 "TP53,AKT1,EGFR"）或单个基因。
            max_results: 最多返回通路数（同时作为 API pageSize）。
            task_id: 关联任务 ID。
            **kwargs: 预留扩展参数。

        Returns:
            DataRecord 列表，每条记录对应一个富集通路。
        """
        if not query or not query.strip():
            return []
        genes = self._parse_genes(query.strip())
        if not genes:
            return []
        body = "\n".join(genes)
        url = f"{self.base_url}/identifiers/form?pageSize={max_results}"
        headers = {"Accept": "application/json"}
        logger.debug(
            "Reactome analysis: %s genes=%d", url, len(genes)
        )
        try:
            text = self._post_raw(url, body, headers=headers)
        except Exception as e:
            logger.error("Reactome 请求失败: %s", e)
            return []
        try:
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError) as e:
            logger.error("Reactome 响应 JSON 解析失败: %s", e)
            return []
        if not isinstance(data, dict):
            return []
        paths = data.get("paths", []) or []
        records: list[dict] = []
        for path in paths:
            if not isinstance(path, dict):
                continue
            pathway_id = path.get("stId") or path.get("stIdVersion") or ""
            if not pathway_id:
                continue
            entities = path.get("entities", {}) or {}
            if not isinstance(entities, dict):
                entities = {}
            entities_found = entities.get("found", 0) or 0
            entities_total = entities.get("total", 0) or 0

            # p_value: 兼容 path.entitiesPValue / path.pValue /
            # entities.pValue / entities.entitiesPValue，缺失时以 found/total ratio 代替
            p_value = (
                path.get("entitiesPValue")
                if path.get("entitiesPValue") is not None
                else path.get("pValue")
            )
            if p_value is None:
                p_value = entities.get("pValue")
            if p_value is None:
                p_value = entities.get("entitiesPValue")
            if p_value is None and entities_total:
                p_value = round(entities_found / entities_total, 6)

            # fdr: 兼容 path.fdr / path.entitiesFdr / entities.fdr
            fdr = path.get("fdr")
            if fdr is None:
                fdr = path.get("entitiesFdr")
            if fdr is None:
                fdr = entities.get("fdr")

            input_genes = self._extract_input_genes(entities, genes)
            fields = {
                "pathway_id": pathway_id,
                "pathway_name": path.get("name", "") or "",
                "species": self._extract_species(path),
                "entities_found": entities_found,
                "entities_total": entities_total,
                "p_value": p_value,
                "fdr": fdr,
                "input_genes": input_genes,
            }
            record = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://reactome.org/content/detail/{pathway_id}",
                accession=pathway_id,
                confidence=0.9,
                method="api",
            )
            records.append(record)
            if len(records) >= max_results:
                break
        return records
