"""内置数据源插件包。

提供 BaseDataSource 抽象基类、RateLimiter 限速器与工具函数，
以及各活跃数据源实现（pubmed/openalex/drugbank/disgenet/...）。

使用方式：
    from app.tools.datasources.base_ds import make_record, utc_now

    rec = make_record("T1", "pubmed", fields, query)
"""
from app.tools.datasources.base_ds import (
    BaseDataSource,
    RateLimiter,
    make_record,
    utc_now,
)

__all__ = [
    "BaseDataSource",
    "RateLimiter",
    "make_record",
    "utc_now",
]
