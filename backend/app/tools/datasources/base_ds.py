"""数据源插件基类与注册表。

提供：
- BaseDataSource 抽象基类，定义统一 search 接口
- DataSourceRegistry 注册表，管理所有内置数据源
- RateLimiter 简单限速器
- make_record 工具函数，构造 DataRecord
"""
from __future__ import annotations

import abc
import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)


# ===== 各数据源 API base URL 常量（从 skill _base.py 迁入）=====
PUBMED_EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
NCBI_EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
GEO_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
STRING_URL = "https://string-db.org/api"
KEGG_URL = "https://rest.kegg.jp"
PDB_URL = "https://search.rcsb.org/rcsbsearch/v2/query"
TCMSP_URL = "https://tcmspw.com/tcmspsearch.php"
CLINICALTRIALS_URL = "https://clinicaltrials.gov/api/v2/studies"
GDC_URL = "https://api.gdc.cancer.gov"
DRUGBANK_URL = "https://api.platform.opentargets.org/api/v4/graphql"
DISGENET_URL = "https://www.disgenet.org/api/gda"
PUBCHEM_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"


def utc_now() -> str:
    """返回 ISO 8601 UTC 时间戳。"""
    return datetime.now(timezone.utc).isoformat()


class RateLimiter:
    """简单限速器：保证两次 wait() 调用间隔 >= interval 秒。"""

    def __init__(self, interval: float = 1.0):
        self.interval = interval
        self._last = 0.0

    def wait(self) -> None:
        now = time.monotonic()
        delta = now - self._last
        if delta < self.interval:
            time.sleep(self.interval - delta)
        self._last = time.monotonic()


def make_record(
    task_id: str,
    source_name: str,
    fields: dict[str, Any],
    query: str,
    url: str | None = None,
    doi: str | None = None,
    accession: str | None = None,
    pmid: str | None = None,
    confidence: float = 0.9,
    method: str = "api",
) -> dict:
    """构造符合 data_record.schema.json 的 DataRecord dict。"""
    raw = f"{source_name}|{query}|{json.dumps(fields, sort_keys=True, default=str)}"
    h8 = hashlib.md5(raw.encode("utf-8")).hexdigest()[:8]
    source_ref: dict[str, Any] = {
        "source_name": source_name,
        "source_type": "api",
        "query": query,
        "retrieved_at": utc_now(),
    }
    if url:
        source_ref["source_url"] = url
    if doi:
        source_ref["source_doi"] = doi
    if accession:
        source_ref["source_accession"] = accession
    if pmid:
        source_ref["source_pmid"] = pmid
    return {
        "record_id": f"{source_name}-{h8}",
        "task_id": task_id,
        "fields": fields,
        "source_ref": source_ref,
        "extraction_method": method,
        "extraction_confidence": confidence,
        "quality_flags": [],
        "created_at": utc_now(),
    }


class BaseDataSource(abc.ABC):
    """数据源抽象基类。

    所有内置数据源继承此类，实现 search() 方法。
    使用 httpx 同步客户端进行 HTTP 调用，支持连接复用。
    """

    name: str = "base"
    description: str = ""
    base_url: str = ""
    default_rate: float = 1.0

    def __init__(self, rate: float | None = None, timeout: int = 60):
        self.limiter = RateLimiter(rate if rate is not None else self.default_rate)
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        """懒初始化 httpx 客户端，支持连接复用。"""
        if self._client is None or self._client.is_closed:
            self._client = httpx.Client(
                timeout=self.timeout,
                headers={"User-Agent": "BioMedQAgent/1.0"},
                follow_redirects=True,
            )
        return self._client

    def _get(self, url: str, params: dict | None = None,
             headers: dict | None = None) -> dict | list:
        """GET 请求并返回 JSON。"""
        self.limiter.wait()
        r = self.client.get(url, params=params, headers=headers)
        r.raise_for_status()
        return r.json()

    def _post(self, url: str, json_body: dict, headers: dict | None = None) -> dict | list:
        """POST 请求并返回 JSON。"""
        self.limiter.wait()
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        r = self.client.post(url, json=json_body, headers=h)
        r.raise_for_status()
        return r.json()

    def _post_raw(self, url: str, content: str, headers: dict | None = None) -> str:
        """POST 原始文本并返回文本响应（用于 Reactome 等纯文本 API）。"""
        self.limiter.wait()
        h = {"Content-Type": "text/plain"}
        if headers:
            h.update(headers)
        r = self.client.post(url, content=content, headers=h)
        r.raise_for_status()
        return r.text

    @abc.abstractmethod
    def search(self, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        """执行检索，返回 DataRecord 列表。"""
        raise NotImplementedError

    def close(self) -> None:
        """关闭 HTTP 客户端。"""
        if self._client and not self._client.is_closed:
            self._client.close()

    def __del__(self):
        self.close()


class DataSourceRegistry:
    """内置数据源注册表。

    管理所有 BaseDataSource 实例，提供按名称访问的能力。
    与 ToolRegistry 互补：ToolRegistry 管理外部脚本，本注册表管理内置数据源。
    """

    def __init__(self):
        self._sources: dict[str, BaseDataSource] = {}

    def register(self, source: BaseDataSource) -> None:
        """注册数据源实例。"""
        self._sources[source.name] = source
        logger.debug("注册数据源: %s", source.name)

    def get(self, name: str) -> BaseDataSource | None:
        """按名称获取数据源。"""
        return self._sources.get(name)

    def list_sources(self) -> list[dict]:
        """列出所有已注册数据源。"""
        return [
            {"name": s.name, "description": s.description}
            for s in self._sources.values()
        ]

    def search(self, name: str, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        """便捷方法：执行指定数据源检索。"""
        source = self.get(name)
        if source is None:
            logger.warning("未知数据源: %s", name)
            return []
        try:
            return source.search(query, max_results=max_results,
                                 task_id=task_id, **kwargs)
        except Exception as e:
            logger.error("数据源 %s 检索失败: %s", name, e)
            return []

    def search_parallel(self, sources: list[str], query: str,
                        max_results: int = 20, task_id: str = "default",
                        **kwargs) -> dict[str, list[dict]]:
        """并行执行多个数据源检索。"""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        results: dict[str, list[dict]] = {}
        with ThreadPoolExecutor(max_workers=min(len(sources), 5)) as pool:
            futures = {
                pool.submit(self.search, name, query, max_results, task_id, **kwargs): name
                for name in sources
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    results[name] = future.result(timeout=90)
                except Exception as e:
                    logger.error("并行检索 %s 失败: %s", name, e)
                    results[name] = []
        return results

    def close_all(self) -> None:
        """关闭所有数据源的 HTTP 客户端。"""
        for source in self._sources.values():
            source.close()


# 全局单例
_registry: DataSourceRegistry | None = None


def get_datasource_registry() -> DataSourceRegistry:
    """获取全局 DataSourceRegistry 单例。"""
    global _registry
    if _registry is None:
        _registry = DataSourceRegistry()
        _register_all(_registry)
    return _registry


def _register_all(registry: DataSourceRegistry) -> None:
    """注册所有内置数据源。"""
    # 延迟导入避免循环依赖
    from app.tools.datasources.uniprot import UniProtSource
    from app.tools.datasources.chembl import ChEMBLSource
    from app.tools.datasources.opentargets import OpenTargetsSource
    from app.tools.datasources.openfda import OpenFDASource
    from app.tools.datasources.reactome import ReactomeSource
    from app.tools.datasources.gprofiler import GProfilerSource
    from app.tools.datasources.enrichr import EnrichrSource
    from app.tools.datasources.ensembl import EnsemblSource
    from app.tools.datasources.hgnc import HGNCSource
    from app.tools.datasources.biogrid import BioGRIDSource
    from app.tools.datasources.ucsc_xena import UCSCXenaSource
    from app.tools.datasources.cbioportal import CBioPortalSource
    from app.tools.datasources.depmap import DepMapSource
    from app.tools.datasources.pdc import PDCSource
    from app.tools.datasources.lincs import LINCSSource
    from app.tools.datasources.drugbank import DrugBankSource
    from app.tools.datasources.omim import OMIMSource
    from app.tools.datasources.disgenet import DisGeNETSource
    from app.tools.datasources.genecards import GeneCardsSource

    sources = [
        UniProtSource(),
        ChEMBLSource(),
        OpenTargetsSource(),
        OpenFDASource(),
        ReactomeSource(),
        GProfilerSource(),
        EnrichrSource(),
        EnsemblSource(),
        HGNCSource(),
        BioGRIDSource(),
        UCSCXenaSource(),
        CBioPortalSource(),
        DepMapSource(),
        PDCSource(),
        LINCSSource(),
        DrugBankSource(),
        OMIMSource(),
        DisGeNETSource(),
        GeneCardsSource(),
    ]
    for source in sources:
        registry.register(source)
