"""Tests for DrugBank, OMIM, DisGeNET, GeneCards data source plugins (Stage 3)."""
from __future__ import annotations

import pytest

from app.tools.datasources.base_ds import get_datasource_registry
from app.tools.registry import ToolRegistry


@pytest.fixture
def registry():
    return get_datasource_registry()


class TestDrugBankSource:
    """DrugBank drug-target-disease data source"""

    def test_registered_in_datasource_registry(self, registry):
        source = registry.get("drugbank")
        assert source is not None
        assert source.name == "drugbank"

    def test_search_drug_known(self, registry):
        """查询已知药物应返回预设靶点数据"""
        results = registry.search("drugbank", "imatinib", max_results=5,
                                  task_id="test-drugbank", mode="drug")
        assert len(results) > 0
        targets = [r["fields"].get("target", "") for r in results]
        assert "ABL1" in targets

    def test_search_drug_unknown(self, registry):
        """查询未知药物应返回空列表"""
        results = registry.search("drugbank", "unknown_drug_xyz", max_results=5,
                                  task_id="test-drugbank", mode="drug")
        assert isinstance(results, list)
        assert len(results) == 0

    def test_search_target_known(self, registry):
        """查询已知靶点应返回药物"""
        results = registry.search("drugbank", "EGFR", max_results=5,
                                  task_id="test-drugbank", mode="target")
        assert len(results) > 0
        drugs = [r["fields"].get("drug_name", "") for r in results]
        assert any("erlotinib" in d.lower() for d in drugs)

    def test_search_target_unknown(self, registry):
        """查询未知靶点应返回空"""
        results = registry.search("drugbank", "GENE_NOT_IN_DB", max_results=5,
                                  task_id="test-drugbank", mode="target")
        assert isinstance(results, list)

    def test_graceful_degradation(self, registry):
        """优雅降级不应抛异常"""
        results = registry.search("drugbank", "", max_results=5,
                                  task_id="test-drugbank")
        assert isinstance(results, list)


class TestOMIMSource:
    """OMIM Mendelian phenotype data source"""

    def test_registered_in_datasource_registry(self, registry):
        source = registry.get("omim")
        assert source is not None
        assert source.name == "omim"

    def test_search_known_gene(self, registry):
        """查询已知基因应返回表型关联"""
        results = registry.search("omim", "TP53", max_results=5,
                                  task_id="test-omim")
        assert len(results) > 0
        fields = results[0]["fields"]
        assert "TP53" in str(fields.get("gene_symbol", ""))
        assert fields.get("disease")

    def test_search_known_gene_brca1(self, registry):
        """查询 BRCA1 应返回 Breast-ovarian cancer"""
        results = registry.search("omim", "BRCA1", max_results=5,
                                  task_id="test-omim")
        assert len(results) > 0
        diseases = [r["fields"].get("disease", "") for r in results]
        assert any("breast" in d.lower() or "ovarian" in d.lower()
                   for d in diseases)

    def test_search_unknown_gene(self, registry):
        """查询未知基因应返回空列表"""
        results = registry.search("omim", "GENE_XYZ_NOT_FOUND", max_results=5,
                                  task_id="test-omim")
        assert isinstance(results, list)

    def test_graceful_degradation(self, registry):
        """优雅降级不应抛异常"""
        results = registry.search("omim", "", max_results=5,
                                  task_id="test-omim")
        assert isinstance(results, list)


class TestDisGeNETSource:
    """DisGeNET gene-disease association data source"""

    def test_registered_in_datasource_registry(self, registry):
        source = registry.get("disgenet")
        assert source is not None
        assert source.name == "disgenet"

    def test_search_gene_known(self, registry):
        """查询已知基因应返回疾病关联"""
        results = registry.search("disgenet", "TP53", max_results=5,
                                  task_id="test-disgenet", mode="gene")
        assert len(results) > 0
        fields = results[0]["fields"]
        assert "TP53" in str(fields.get("gene_symbol", ""))
        assert fields.get("disease")

    def test_search_gene_unknown(self, registry):
        """查询未知基因应返回空列表"""
        results = registry.search("disgenet", "GENE_NOT_IN_DB", max_results=5,
                                  task_id="test-disgenet", mode="gene")
        assert isinstance(results, list)

    def test_search_disease_known(self, registry):
        """查询已知疾病应返回基因"""
        results = registry.search("disgenet", "breast cancer", max_results=5,
                                  task_id="test-disgenet", mode="disease")
        assert len(results) > 0
        genes = [r["fields"].get("gene_symbol", "") for r in results]
        assert "BRCA1" in genes or "BRCA2" in genes or "TP53" in genes

    def test_search_disease_unknown(self, registry):
        """查询未知疾病应返回空"""
        results = registry.search("disgenet", "unknown_disease_xyz", max_results=5,
                                  task_id="test-disgenet", mode="disease")
        assert isinstance(results, list)

    def test_graceful_degradation(self, registry):
        """优雅降级不应抛异常"""
        results = registry.search("disgenet", "", max_results=5,
                                  task_id="test-disgenet")
        assert isinstance(results, list)


class TestGeneCardsSource:
    """GeneCards gene-centric integrative knowledge source"""

    def test_registered_in_datasource_registry(self, registry):
        source = registry.get("genecards")
        assert source is not None
        assert source.name == "genecards"

    def test_search_known_gene(self, registry):
        """查询已知基因应返回摘要信息"""
        results = registry.search("genecards", "TP53", max_results=5,
                                  task_id="test-genecards")
        assert len(results) > 0
        fields = results[0]["fields"]
        assert "TP53" in str(fields.get("gene_symbol", ""))
        assert fields.get("function")
        assert fields.get("location")

    def test_search_known_gene_egfr(self, registry):
        """查询 EGFR 应返回受体酪氨酸激酶信息"""
        results = registry.search("genecards", "EGFR", max_results=5,
                                  task_id="test-genecards")
        assert len(results) > 0
        func = results[0]["fields"].get("function", "").lower()
        assert "tyrosine kinase" in func or "receptor" in func

    def test_search_unknown_gene(self, registry):
        """查询未知基因应返回空列表"""
        results = registry.search("genecards", "GENE_NOT_IN_DB", max_results=5,
                                  task_id="test-genecards")
        assert isinstance(results, list)
        assert len(results) == 0

    def test_graceful_degradation(self, registry):
        """优雅降级不应抛异常"""
        results = registry.search("genecards", "", max_results=5,
                                  task_id="test-genecards")
        assert isinstance(results, list)


class TestDormantRegistration:
    """验证 4 个新数据源在 ToolRegistry 的 dormant 列表中"""

    def test_drugbank_in_dormant_list(self):
        assert "drugbank" in ToolRegistry._DORMANT_DS_NAMES

    def test_omim_in_dormant_list(self):
        assert "omim" in ToolRegistry._DORMANT_DS_NAMES

    def test_disgenet_in_dormant_list(self):
        assert "disgenet" in ToolRegistry._DORMANT_DS_NAMES

    def test_genecards_in_dormant_list(self):
        assert "genecards" in ToolRegistry._DORMANT_DS_NAMES

    def test_dormant_count_increased(self):
        """从 15 增加到 19"""
        assert len(ToolRegistry._DORMANT_DS_NAMES) == 21

    def test_list_all_four(self, registry):
        """DataSourceRegistry 应列出所有 4 个新数据源"""
        sources = {s["name"] for s in registry.list_sources()}
        for name in ("drugbank", "omim", "disgenet", "genecards"):
            assert name in sources, f"{name} not in DataSourceRegistry"
