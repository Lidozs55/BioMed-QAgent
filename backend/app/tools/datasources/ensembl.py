"""Ensembl 数据源插件。

通过 Ensembl REST API 检索基因组注释与 ID 映射信息。
API 文档: https://rest.ensembl.org
限速: 15 req/sec（保守取 0.3s 间隔）
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)

_JSON_HEADERS = {"Accept": "application/json"}


class EnsemblSource(BaseDataSource):
    """Ensembl 基因组注释与 ID 映射数据源。

    支持三种检索模式：
    - symbol: 按基因符号查询（如 TP53），先查 xrefs/symbol 获取 Ensembl ID，
      再对每个 ID 调用 lookup/id 获取基因详情
    - xref:   按外部数据库 ID 查询（如 UniProt ID），通过 xrefs/name 接口
    - id:     直接按 Ensembl ID 查询（如 ENSG00000141510），通过 lookup/id 接口
    """

    name: str = "ensembl"
    description: str = "Ensembl 基因组注释与 ID 映射"
    base_url: str = "https://rest.ensembl.org"
    default_rate: float = 0.3

    def _safe_get(self, url: str, headers: dict | None = None) -> dict | list | None:
        """GET 请求，出错（如 404）返回 None 而非抛出。"""
        try:
            return self._get(url, headers=headers)
        except Exception as e:
            logger.debug("Ensembl GET %s 失败: %s", url, e)
            return None

    def _lookup(self, ensembl_id: str) -> dict | None:
        """调用 lookup/id 接口获取基因详情。"""
        url = f"{self.base_url}/lookup/id/{ensembl_id}"
        data = self._safe_get(url, headers=_JSON_HEADERS)
        if not isinstance(data, dict) or not data:
            return None
        return data

    def _record_from_lookup(
        self, lookup: dict, task_id: str, query: str
    ) -> dict | None:
        """从 lookup/id 响应构造 DataRecord。"""
        if not isinstance(lookup, dict) or not lookup:
            return None
        ensembl_id = lookup.get("id", "") or ""
        if not ensembl_id:
            return None
        fields = {
            "ensembl_id": ensembl_id,
            "gene_symbol": lookup.get("display_name", "") or "",
            "biotype": lookup.get("biotype", "") or "",
            "chromosome": lookup.get("seq_region_name", "") or "",
            "start": lookup.get("start", 0) or 0,
            "end": lookup.get("end", 0) or 0,
            "strand": lookup.get("strand", 0) or 0,
            "description": lookup.get("description", "") or "",
            "species": lookup.get("species", "") or "",
        }
        url = f"https://www.ensembl.org/Homo_sapiens/Gene/Summary?g={ensembl_id}"
        return make_record(
            task_id=task_id,
            source_name=self.name,
            fields=fields,
            query=query,
            url=url,
            accession=ensembl_id,
            confidence=1.0,
            method="api",
        )

    def _record_from_xref(
        self, xref: dict, task_id: str, query: str
    ) -> dict | None:
        """从 xrefs 响应条目构造 DataRecord（无 lookup 详情时使用）。"""
        if not isinstance(xref, dict) or not xref:
            return None
        ensembl_id = xref.get("id", "") or ""
        if not ensembl_id:
            return None
        gene_symbol = (
            xref.get("display_id")
            or xref.get("display_name")
            or xref.get("name")
            or ""
        )
        fields = {
            "ensembl_id": ensembl_id,
            "gene_symbol": gene_symbol,
            "biotype": "",
            "chromosome": "",
            "start": 0,
            "end": 0,
            "strand": 0,
            "description": xref.get("description", "") or "",
            "species": "homo_sapiens",
            "dbname": xref.get("dbname", "") or "",
        }
        url = f"https://www.ensembl.org/Homo_sapiens/Gene/Summary?g={ensembl_id}"
        return make_record(
            task_id=task_id,
            source_name=self.name,
            fields=fields,
            query=query,
            url=url,
            accession=ensembl_id,
            confidence=1.0,
            method="api",
        )

    def search(
        self,
        query: str,
        max_results: int = 20,
        task_id: str = "default",
        **kwargs: Any,
    ) -> list[dict]:
        """检索 Ensembl 基因记录。

        Args:
            query: 基因符号、外部 ID 或 Ensembl ID。
            max_results: 最多返回记录数。
            task_id: 关联任务 ID。
            **kwargs:
                mode: 检索模式，"symbol"（默认）/ "xref" / "id"
                dbname: xref 模式下的外部数据库名（如 "UniProt"）

        Returns:
            DataRecord 列表。
        """
        if not query or not query.strip():
            return []
        q = query.strip()
        mode = kwargs.get("mode", "symbol")
        if mode == "xref":
            return self._search_xref(q, max_results, task_id, kwargs)
        if mode == "id":
            return self._search_id(q, task_id)
        return self._search_symbol(q, max_results, task_id)

    def _search_symbol(
        self, query: str, max_results: int, task_id: str
    ) -> list[dict]:
        """symbol 模式：按基因符号查询，对每个匹配 ID 再查 lookup 详情。"""
        url = f"{self.base_url}/xrefs/symbol/homo_sapiens/{query}"
        logger.debug("Ensembl symbol search: %s", url)
        data = self._safe_get(url, headers=_JSON_HEADERS)
        if not isinstance(data, list):
            return []
        records: list[dict] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            ensembl_id = item.get("id", "") or ""
            if not ensembl_id:
                continue
            lookup = self._lookup(ensembl_id)
            if lookup is not None:
                rec = self._record_from_lookup(lookup, task_id, query)
            else:
                # lookup 失败时退化使用 xref 条目构造记录
                rec = self._record_from_xref(item, task_id, query)
            if rec:
                records.append(rec)
                if len(records) >= max_results:
                    break
        return records

    def _search_xref(
        self, query: str, max_results: int, task_id: str, kwargs: dict
    ) -> list[dict]:
        """xref 模式：按外部数据库 ID 查询。"""
        dbname = kwargs.get("dbname", "UniProt")
        url = f"{self.base_url}/xrefs/name/human/{dbname}/{query}"
        logger.debug("Ensembl xref search: %s", url)
        data = self._safe_get(url, headers=_JSON_HEADERS)
        if not isinstance(data, list):
            return []
        records: list[dict] = []
        for item in data:
            rec = self._record_from_xref(item, task_id, query)
            if rec:
                records.append(rec)
                if len(records) >= max_results:
                    break
        return records

    def _search_id(self, query: str, task_id: str) -> list[dict]:
        """id 模式：直接按 Ensembl ID 查询。"""
        lookup = self._lookup(query)
        if lookup is None:
            return []
        rec = self._record_from_lookup(lookup, task_id, query)
        return [rec] if rec else []
