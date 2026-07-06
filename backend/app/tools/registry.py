"""工具注册表 — 统一管理所有脚本工具。

提供按名称、按类别访问脚本的能力，并支持动态扩展。
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.script_tool import (
    ScriptRunner,
    ScriptResult,
    DATASOURCE_SCRIPTS,
    PARSER_SCRIPTS,
    CLEANER_SCRIPTS,
    ANALYSIS_SCRIPTS,
    EXPORT_SCRIPTS,
    OPTIMIZATION_SCRIPTS,
    PROVENANCE_SCRIPTS,
    VIZ_SCRIPTS,
    IO_SCRIPTS,
    get_all_script_maps,
)

logger = logging.getLogger(__name__)


class ToolRegistry:
    """脚本工具注册表。

    按类别组织所有脚本，提供统一访问接口。
    """

    def __init__(self):
        self._runners: dict[str, ScriptRunner] = {}
        self._categories: dict[str, dict[str, ScriptRunner]] = {}
        self._register_all()

    def _register_all(self):
        """注册所有内置脚本。"""
        for category, scripts in get_all_script_maps().items():
            cat_dict: dict[str, ScriptRunner] = {}
            for name, (path, desc) in scripts.items():
                runner = ScriptRunner(path, name=name, description=desc)
                self._runners[name] = runner
                cat_dict[name] = runner
            self._categories[category] = cat_dict
            logger.debug("注册类别 %s: %d 个工具", category, len(cat_dict))

    def get(self, name: str) -> ScriptRunner | None:
        """按名称获取脚本运行器。"""
        return self._runners.get(name)

    def get_category(self, category: str) -> dict[str, ScriptRunner]:
        """按类别获取所有脚本运行器。"""
        return self._categories.get(category, {})

    def list_tools(self) -> dict[str, list[dict]]:
        """列出所有工具，按类别分组。"""
        result: dict[str, list[dict]] = {}
        for cat, runners in self._categories.items():
            result[cat] = [
                {"name": r.name, "description": r.description, "script": r.script_path}
                for r in runners.values()
            ]
        return result

    def run(self, name: str, args: list[str] = None,
            timeout: int = 120, env: dict | None = None) -> ScriptResult:
        """执行指定脚本。"""
        runner = self.get(name)
        if not runner:
            return ScriptResult(False, error=f"未知工具: {name}")
        return runner.run(args, timeout=timeout, env=env)

    def run_datasource(self, name: str, query: str, max_results: int = 20,
                        task_id: str = "T0", timeout: int = 60) -> ScriptResult:
        """便捷方法：执行数据源检索。"""
        runner = self.get(name)
        if not runner:
            return ScriptResult(False, error=f"未知数据源: {name}")
        args = ["--query", query, "--max", str(max_results), "--task-id", task_id]
        return runner.run(args, timeout=timeout)

    def run_datasources_parallel(self, sources: list[str], query: str,
                                  max_results: int = 20, task_id: str = "T0") -> dict[str, ScriptResult]:
        """并行执行多个数据源检索（使用线程池）。"""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        results: dict[str, ScriptResult] = {}
        with ThreadPoolExecutor(max_workers=min(len(sources), 5)) as pool:
            futures = {
                pool.submit(self.run_datasource, name, query, max_results, task_id): name
                for name in sources
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    results[name] = future.result(timeout=90)
                except Exception as e:
                    results[name] = ScriptResult(False, error=str(e))
        return results


# 全局单例
_registry: ToolRegistry | None = None


def get_registry() -> ToolRegistry:
    """获取全局 ToolRegistry 单例。"""
    global _registry
    if _registry is None:
        _registry = ToolRegistry()
    return _registry
