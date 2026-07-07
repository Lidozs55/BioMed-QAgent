"""内置数据源插件包。

提供 BaseDataSource 抽象基类、DataSourceRegistry 注册表，
以及 13 个内置数据源实现。

使用方式：
    from app.tools.datasources import get_datasource_registry

    registry = get_datasource_registry()
    records = registry.search("uniprot", "TP53", max_results=10, task_id="T1")
"""
from app.tools.datasources.base_ds import (
    BaseDataSource,
    DataSourceRegistry,
    RateLimiter,
    get_datasource_registry,
    make_record,
    utc_now,
)

__all__ = [
    "BaseDataSource",
    "DataSourceRegistry",
    "RateLimiter",
    "get_datasource_registry",
    "make_record",
    "utc_now",
]
