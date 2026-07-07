"""ChEMBL 数据源插件。

ChEMBL REST API: https://www.ebi.ac.uk/chembl/api/data
支持 compound / target / activity 三种检索模式。
"""
from __future__ import annotations

import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class ChEMBLSource(BaseDataSource):
    """ChEMBL 数据源：药物-靶点-生物活性检索。"""

    name: str = "chembl"
    description: str = "ChEMBL 药物-靶点-生物活性"
    base_url: str = "https://www.ebi.ac.uk/chembl/api/data"
    default_rate: float = 1.0

    def search(self, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        """执行 ChEMBL 检索。

        kwargs:
            mode: compound / target / activity，默认 compound
        """
        mode = kwargs.get("mode", "compound")
        if mode == "target":
            return self._search_target(query, max_results, task_id)
        if mode == "activity":
            return self._search_activity(query, max_results, task_id)
        if mode != "compound":
            logger.warning("ChEMBL 未知 mode: %s, 回退到 compound", mode)
        return self._search_compound(query, max_results, task_id)

    # ---- 各模式实现 ----

    def _search_compound(self, query: str, max_results: int,
                         task_id: str) -> list[dict]:
        url = f"{self.base_url}/molecule.json"
        params = {"search": query, "limit": max_results}
        data = self._get(url, params=params)
        molecules = self._extract_list(data, "molecules")
        records: list[dict] = []
        for mol in molecules:
            chembl_id = mol.get("molecule_chembl_id")
            if not chembl_id:
                continue
            structures = mol.get("molecule_structures") or {}
            fields: dict[str, Any] = {
                "molecule_chembl_id": chembl_id,
                "pref_name": mol.get("pref_name"),
                "molecule_type": mol.get("molecule_type"),
                "smiles": structures.get("canonical_smiles"),
                "inchi_key": structures.get("standard_inchi_key"),
                "max_phase": mol.get("max_phase"),
                "therapeutic_flag": mol.get("therapeutic_flag"),
            }
            records.append(make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://www.ebi.ac.uk/chembl/compound_report_card/{chembl_id}",
                accession=chembl_id,
                confidence=0.95,
            ))
        return records

    def _search_target(self, query: str, max_results: int,
                       task_id: str) -> list[dict]:
        url = f"{self.base_url}/target.json"
        params = {"search": query, "limit": max_results}
        data = self._get(url, params=params)
        targets = self._extract_list(data, "targets")
        records: list[dict] = []
        for tgt in targets:
            chembl_id = tgt.get("target_chembl_id")
            if not chembl_id:
                continue
            fields: dict[str, Any] = {
                "target_chembl_id": chembl_id,
                "pref_name": tgt.get("pref_name"),
                "target_type": tgt.get("target_type"),
                "organism": tgt.get("organism"),
                "gene_names": self._extract_gene_names(tgt),
            }
            records.append(make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=f"https://www.ebi.ac.uk/chembl/target_report_card/{chembl_id}",
                accession=chembl_id,
                confidence=0.95,
            ))
        return records

    def _search_activity(self, query: str, max_results: int,
                         task_id: str) -> list[dict]:
        url = f"{self.base_url}/activity.json"
        params = {"search": query, "limit": max_results}
        data = self._get(url, params=params)
        activities = self._extract_list(data, "activities")
        records: list[dict] = []
        for act in activities:
            activity_id = act.get("activity_id")
            mol_id = act.get("molecule_chembl_id")
            target_id = act.get("target_chembl_id")
            if activity_id is None and not mol_id and not target_id:
                continue
            fields: dict[str, Any] = {
                "activity_id": activity_id,
                "assay_chembl_id": act.get("assay_chembl_id"),
                "target_chembl_id": target_id,
                "molecule_chembl_id": mol_id,
                "type": act.get("type"),
                "value": act.get("value"),
                "units": act.get("units"),
                "pchembl_value": act.get("pchembl_value"),
            }
            # URL/accession 优先用 molecule_chembl_id，其次 target_chembl_id
            ref_id = mol_id or target_id
            if ref_id:
                report_url = (
                    f"https://www.ebi.ac.uk/chembl/compound_report_card/{ref_id}"
                    if mol_id else
                    f"https://www.ebi.ac.uk/chembl/target_report_card/{ref_id}"
                )
                accession = ref_id
            else:
                report_url = None
                accession = str(activity_id) if activity_id is not None else None
            records.append(make_record(
                task_id=task_id,
                source_name=self.name,
                fields=fields,
                query=query,
                url=report_url,
                accession=accession,
                confidence=0.85,
            ))
        return records

    # ---- 辅助方法 ----

    @staticmethod
    def _extract_list(data: Any, key: str) -> list[dict]:
        """从 ChEMBL 响应中安全提取列表字段。"""
        if isinstance(data, dict):
            items = data.get(key, [])
            return items if isinstance(items, list) else []
        return []

    @staticmethod
    def _extract_gene_names(target: dict) -> list[str] | None:
        """从 target_components.synonyms 中提取基因符号。

        ChEMBL target 没有 top-level gene_names 字段，需从
        target_components[].target_component_synonyms[] 中按 syn_type 提取。
        """
        components = target.get("target_components") or []
        names: list[str] = []
        for comp in components:
            for syn in comp.get("target_component_synonyms") or []:
                if syn.get("syn_type") == "GENE_SYMBOL":
                    val = syn.get("component_synonym")
                    if val:
                        names.append(val)
        return names or None
