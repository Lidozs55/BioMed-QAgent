"""BioGRID 数据源插件。

通过 BioGRID REST API 按基因符号检索蛋白质互作网络。
API 文档: https://wiki.thebiogrid.org/wiki/BioGRID_REST
"""
from __future__ import annotations

import logging
import os
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class BioGRIDSource(BaseDataSource):
    """BioGRID 蛋白质互作网络数据源。

    通过 BioGRID REST API 按基因符号查询蛋白质-蛋白质互作，
    包括互作蛋白符号、BioGRID ID、实验系统、得分、PubMed 引用等。
    """

    name: str = "biogrid"
    description: str = "BioGRID 蛋白质互作网络"
    base_url: str = "https://webservice.thebiogrid.org"
    default_rate: float = 1.0

    # 公开测试 accesskey，实际应通过环境变量 BIOGRID_API_KEY 提供
    _TEST_ACCESSKEY = "0c96a6e6903dac68743c5e5e5e5e5e5e"

    def _get_accesskey(self) -> str:
        """从环境变量读取 BioGRID accesskey，缺失时回退到公开测试 key。"""
        return os.environ.get("BIOGRID_API_KEY") or self._TEST_ACCESSKEY

    @staticmethod
    def _as_str(value: Any) -> str:
        """安全转换为字符串，None 返回空串。"""
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        return str(value)

    def search(
        self,
        query: str,
        max_results: int = 20,
        task_id: str = "default",
        **kwargs: Any,
    ) -> list[dict]:
        """按基因符号检索 BioGRID 蛋白质互作记录。

        Args:
            query: 基因符号（如 TP53）。
            max_results: 最多返回记录数。
            task_id: 关联任务 ID。
            **kwargs: 预留扩展参数。

        Returns:
            DataRecord 列表，每条记录描述一对蛋白质互作。
        """
        if not query or not query.strip():
            return []
        gene = query.strip()
        params = {
            "geneList": gene,
            "taxId": 9606,
            "format": "json",
            "includeHeader": "true",
            "accesskey": self._get_accesskey(),
            "includeInteractors": "true",
            "includeInteractorInteractions": "false",
        }
        url = f"{self.base_url}/interactions/"
        logger.debug("BioGRID search: %s params=%s", url, params)
        data = self._get(url, params=params)
        # BioGRID 返回 {"interaction_id": {...}, ...}
        if not isinstance(data, dict):
            return []

        records: list[dict] = []
        for interaction_id, inter in data.items():
            if not isinstance(inter, dict):
                continue
            protein_a = self._as_str(inter.get("OFFICIAL_SYMBOL_A"))
            protein_b = self._as_str(inter.get("OFFICIAL_SYMBOL_B"))
            protein_a_id = self._as_str(inter.get("BIOGRID_ID_A"))
            protein_b_id = self._as_str(inter.get("BIOGRID_ID_B"))

            # 得分：优先 AUTHORS_SCORE，回退 EXPERIMENTAL_SCORE / SCORE
            score = self._as_str(inter.get("AUTHORS_SCORE"))
            if not score:
                score = self._as_str(inter.get("EXPERIMENTAL_SCORE"))
            if not score:
                score = self._as_str(inter.get("SCORE"))

            fields = {
                "protein_a": protein_a,
                "protein_b": protein_b,
                "protein_a_id": protein_a_id,
                "protein_b_id": protein_b_id,
                "score": score,
                "experiment": self._as_str(inter.get("EXPERIMENTAL_SYSTEM")),
                "experiment_type": self._as_str(
                    inter.get("EXPERIMENTAL_SYSTEM_TYPE")
                ),
                "pubmed_id": self._as_str(inter.get("PUBMED_ID")),
                "source_database": self._as_str(inter.get("SOURCE_DATABASE")),
                "throughput": self._as_str(inter.get("THROUGHPUT")),
                "modification": self._as_str(inter.get("MODIFICATION")),
            }

            link = (
                f"https://thebiogrid.org/{protein_a_id}"
                if protein_a_id
                else f"https://thebiogrid.org/search.php?search={gene}"
            )

            record = make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=link,
                accession=str(interaction_id),
                confidence=0.9,
                method="api",
            )
            records.append(record)
            if len(records) >= max_results:
                break
        return records
