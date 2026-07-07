"""openFDA 数据源插件。

对接 openFDA API (https://api.fda.gov)，提供药品不良事件、标签与召回信息检索。
无需 API key 即可工作（限速较严，每分钟 40 次）；配置 key 后限额更高。
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class OpenFDASource(BaseDataSource):
    """openFDA 数据源。

    支持三种 endpoint：
    - drug_event: 药品不良事件（adverse event）
    - drug_label: 药品标签信息
    - drug_enforcement: 药品召回执行信息
    """

    name = "openfda"
    description = "openFDA 药品不良事件与标签"
    base_url = "https://api.fda.gov"
    default_rate = 0.5  # openFDA 限速较严，每秒 2 次（无 key 每分钟 40 次）

    def search(self, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        """检索 openFDA 数据。

        kwargs:
            endpoint: 数据端点，drug_event / drug_label / drug_enforcement
                      默认 drug_event。
        """
        endpoint = kwargs.get("endpoint", "drug_event")
        if endpoint == "drug_label":
            return self._search_drug_label(query, max_results, task_id)
        if endpoint == "drug_enforcement":
            return self._search_drug_enforcement(query, max_results, task_id)
        if endpoint != "drug_event":
            logger.warning("openfda 未知 endpoint: %s，回退到 drug_event", endpoint)
        return self._search_drug_event(query, max_results, task_id)

    # ------------------------------------------------------------------
    # 端点实现
    # ------------------------------------------------------------------

    def _search_drug_event(self, query: str, max_results: int,
                           task_id: str) -> list[dict]:
        """药品不良事件检索。"""
        url = f"{self.base_url}/drug/event.json"
        params = {
            "search": f'patient.drug.medicinalproduct.exact:"{query}"',
            "limit": max_results,
        }
        results = self._fda_get(url, params, query)
        records: list[dict] = []
        for item in results:
            fields = self._extract_event_fields(item)
            records.append(make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=url,
                confidence=0.95,
            ))
        return records

    def _search_drug_label(self, query: str, max_results: int,
                           task_id: str) -> list[dict]:
        """药品标签检索。"""
        url = f"{self.base_url}/drug/label.json"
        params = {
            "search": f'openfda.brand_name.exact:"{query}"',
            "limit": max_results,
        }
        results = self._fda_get(url, params, query)
        records: list[dict] = []
        for item in results:
            fields = self._extract_label_fields(item)
            records.append(make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=url,
                confidence=0.95,
            ))
        return records

    def _search_drug_enforcement(self, query: str, max_results: int,
                                 task_id: str) -> list[dict]:
        """药品召回检索。"""
        url = f"{self.base_url}/drug/enforcement.json"
        params = {
            "search": f'brand_name:"{query}"',
            "limit": max_results,
        }
        results = self._fda_get(url, params, query)
        records: list[dict] = []
        for item in results:
            fields = self._extract_enforcement_fields(item)
            records.append(make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=url,
                confidence=0.95,
            ))
        return records

    # ------------------------------------------------------------------
    # 请求与结果解析
    # ------------------------------------------------------------------

    def _fda_get(self, url: str, params: dict, query: str) -> list[dict]:
        """GET 并处理 openFDA「无结果返回 404」的特殊行为。

        openFDA 在没有匹配结果时会以 404 状态码返回错误体，而非空 results。
        此处将其视为正常空结果，其余 4xx/5xx 仍向上抛出。
        """
        try:
            data = self._get(url, params=params)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                logger.info("openfda 检索无结果: query=%s", query)
                return []
            raise
        return self._extract_results(data)

    @staticmethod
    def _extract_results(data: Any) -> list[dict]:
        """从 openFDA 响应中取出 results 列表。"""
        if not isinstance(data, dict):
            return []
        results = data.get("results")
        if not isinstance(results, list):
            return []
        return results

    @staticmethod
    def _first(value: Any) -> Any:
        """取列表首元素；非列表原样返回；None 返回 None。"""
        if isinstance(value, list):
            return value[0] if value else None
        return value

    # ------------------------------------------------------------------
    # 字段提取（处理缺失）
    # ------------------------------------------------------------------

    def _extract_event_fields(self, item: dict) -> dict[str, Any]:
        """提取不良事件字段。"""
        patient = item.get("patient") or {}
        drugs = patient.get("drug") or []
        reactions = patient.get("reaction") or []
        drug0 = drugs[0] if drugs else {}
        reaction0 = reactions[0] if reactions else {}

        # openFDA 用多个 seriousness* 布尔字段标记具体严重类型，
        # 这里收集所有命中的类型；若仅有顶层 serious 标记则用 "serious"。
        flags = [
            key.split("seriousness")[1]
            for key in item
            if key.startswith("seriousness") and item.get(key) in (1, "1", True)
        ]
        if not flags and item.get("serious") in (1, "1", True):
            flags = ["serious"]

        return {
            "safety_report_id": item.get("safety_report_id"),
            "patient_age": patient.get("patientonsetage"),
            "patient_sex": patient.get("patientsex"),
            "drug_name": drug0.get("medicinalproduct"),
            "reaction": reaction0.get("reactionmeddrapt"),
            "seriousness": flags if flags else None,
        }

    def _extract_label_fields(self, item: dict) -> dict[str, Any]:
        """提取药品标签字段。"""
        openfda = item.get("openfda") or {}
        return {
            "id": item.get("id"),
            "brand_name": self._first(openfda.get("brand_name")),
            "generic_name": self._first(openfda.get("generic_name")),
            "manufacturer": self._first(openfda.get("manufacturer_name")),
            "purpose": self._first(item.get("purpose")),
            "indications_and_usage": self._first(item.get("indications_and_usage")),
        }

    def _extract_enforcement_fields(self, item: dict) -> dict[str, Any]:
        """提取召回执行字段。"""
        return {
            "recall_number": item.get("recall_number"),
            "recalling_firm": item.get("recalling_firm"),
            "product_description": item.get("product_description"),
            "reason_for_recall": item.get("reason_for_recall"),
            "classification": item.get("classification"),
            "status": item.get("status"),
            "recall_initiation_date": item.get("recall_initiation_date"),
        }
