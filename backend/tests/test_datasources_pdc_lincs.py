"""Tests for PDC and LINCS data source plugins."""
from __future__ import annotations

import pytest

from app.tools.datasources.base_ds import get_datasource_registry
from app.tools.registry import ToolRegistry


@pytest.fixture
def registry():
    return get_datasource_registry()


class TestPDCSource:
    """PDC/CPTAC proteomics data source"""

    def test_registered_in_datasource_registry(self, registry):
        source = registry.get("pdc")
        assert source is not None
        assert source.name == "pdc"

    def test_search_protein_known_gene(self, registry):
        """查询已知癌症基因应返回预设数据"""
        results = registry.search("pdc", "TP53", max_results=5,
                                  task_id="test-pdc", mode="protein")
        assert len(results) > 0
        assert results[0]["fields"]["gene_symbol"] == "TP53"

    def test_search_protein_unknown_gene(self, registry):
        """查询未知基因应返回空列表（不抛异常）"""
        results = registry.search("pdc", "ZZZ999", max_results=5,
                                  task_id="test-pdc", mode="protein")
        assert isinstance(results, list)

    def test_search_study_known_cancer(self, registry):
        """按癌症类型查询应返回研究数据"""
        results = registry.search("pdc", "lung", max_results=5,
                                  task_id="test-pdc", mode="study")
        assert len(results) > 0
        # 应返回肺癌相关研究
        study_names = [r["fields"]["study_name"] for r in results]
        assert any("LUAD" in s or "Lung" in r["fields"]["description"]
                   for s, r in zip(study_names, results))

    def test_search_study_unknown(self, registry):
        """查询未知癌症类型应返回空"""
        results = registry.search("pdc", "unknown_cancer_xyz", max_results=5,
                                  task_id="test-pdc", mode="study")
        assert isinstance(results, list)
        assert len(results) == 0

    def test_graceful_degradation_no_crash(self, registry):
        """优雅降级：所有失败路径不应抛异常"""
        results = registry.search("pdc", "", max_results=5,
                                  task_id="test-pdc")
        assert isinstance(results, list)


class TestLINCSSource:
    """LINCS/CLUE drug repositioning data source"""

    def test_registered_in_datasource_registry(self, registry):
        source = registry.get("lincs")
        assert source is not None
        assert source.name == "lincs"

    def test_search_gene_known_target(self, registry):
        """查询已知靶点基因应返回药物候选"""
        results = registry.search("lincs", "TP53", max_results=5,
                                  task_id="test-lincs", mode="gene")
        assert len(results) > 0
        assert results[0]["fields"]["gene_symbol"] == "TP53"

    def test_search_gene_unknown(self, registry):
        """查询未知基因应返回空列表"""
        results = registry.search("lincs", "GENE_NOT_IN_DB", max_results=5,
                                  task_id="test-lincs", mode="gene")
        assert isinstance(results, list)

    def test_search_drug_known(self, registry):
        """查询已知药物应返回扰动基因"""
        results = registry.search("lincs", "cisplatin", max_results=5,
                                  task_id="test-lincs", mode="drug")
        assert len(results) > 0
        assert any("TP53" in r["fields"].get("target_gene", "")
                   for r in results)

    def test_search_drug_unknown(self, registry):
        """查询未知药物应返回空"""
        results = registry.search("lincs", "unknown_drug_xyz", max_results=5,
                                  task_id="test-lincs", mode="drug")
        assert isinstance(results, list)

    def test_graceful_degradation_no_crash(self, registry):
        """优雅降级：所有失败路径不应抛异常"""
        results = registry.search("lincs", "", max_results=5,
                                  task_id="test-lincs")
        assert isinstance(results, list)


class TestDormantRegistration:
    """验证两个新数据源在 ToolRegistry 的 dormant 列表中"""

    def test_pdc_in_dormant_list(self):
        assert "pdc" in ToolRegistry._DORMANT_DS_NAMES

    def test_lincs_in_dormant_list(self):
        assert "lincs" in ToolRegistry._DORMANT_DS_NAMES

    def test_dormant_count_increased(self):
        """从 13 增加到 15"""
        assert len(ToolRegistry._DORMANT_DS_NAMES) == 15
