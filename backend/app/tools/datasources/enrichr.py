"""Enrichr 数据源插件。

通过 Enrichr API 进行基因集富集分析。
API: https://maayanlab.cloud/Enrichr
限速: 1 req/sec（无需 API key）
"""
from __future__ import annotations

import logging

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class EnrichrSource(BaseDataSource):
    """Enrichr 数据源。

    接收一组基因符号（逗号分隔），上传至 Enrichr 后查询多个库的富集结果。
    """

    name = "enrichr"
    description = "Enrichr 基因集富集分析"
    base_url = "https://maayanlab.cloud/Enrichr"
    default_rate = 1.0

    # 常用富集库
    _LIBRARIES = [
        "KEGG_2021_Human",
        "GO_Biological_Process_2023",
        "Reactome_2022",
        "WikiPathway_2023_Human",
    ]

    def search(self, query: str, max_results: int = 20,
               task_id: str = "default", **kwargs) -> list[dict]:
        """执行基因集富集分析，返回 DataRecord 列表。

        Args:
            query: 基因符号，逗号分隔（如 "TP53,AKT1,EGFR"）或单个基因
            max_results: 每个库取前 N 条结果
            task_id: 任务 ID，用作基因列表描述
        """
        # 1. 解析基因列表
        genes = [g.strip() for g in query.split(",") if g.strip()]
        if not genes:
            logger.warning("enrichr: 空基因列表 query=%s", query)
            return []

        gene_list_str = "\n".join(genes)

        # 2. 上传基因列表，获取 userListId
        user_list_id = self._add_list(gene_list_str, task_id)
        if user_list_id is None:
            return []

        try:
            # 3. 对每个库查询富集结果，每个库取前 max_results 条
            records: list[dict] = []
            for library in self._LIBRARIES:
                lib_records = self._enrich(
                    user_list_id, library, query, max_results, task_id,
                )
                records.extend(lib_records)
            return records
        finally:
            # 4. best-effort 清理上传的基因列表
            self._delete_list(user_list_id)

    def _add_list(self, gene_list_str: str, description: str) -> int | None:
        """POST /addList 上传基因列表，返回 userListId。

        Enrichr addList 需要 multipart form data：
        - list: 基因列表文本（每行一个基因）
        - description: 列表描述
        """
        url = f"{self.base_url}/addList"
        try:
            self.limiter.wait()
            files = {"list": ("genes.txt", gene_list_str, "text/plain")}
            data = {"description": description}
            r = self.client.post(url, files=files, data=data)
            r.raise_for_status()
            payload = r.json()
            user_list_id = payload.get("userListId")
            if user_list_id is None:
                logger.warning("enrichr: addList 未返回 userListId: %s", payload)
                return None
            return int(user_list_id)
        except Exception as e:
            logger.error("enrichr: addList 失败: %s", e)
            return None

    def _enrich(self, user_list_id: int, library: str, query: str,
                max_results: int, task_id: str) -> list[dict]:
        """GET /enrich 查询单个库的富集结果。

        Enrichr 返回格式（数组列表，按位置索引）：
        [rank, term_name, p_value, z_score, combined_score,
         overlapping_genes, adj_p_value, old_p_value, old_adj_p_value]
        """
        url = f"{self.base_url}/enrich"
        params = {"userListId": user_list_id, "backgroundType": library}
        try:
            payload = self._get(url, params=params)
        except Exception as e:
            logger.warning("enrichr: enrich 库 %s 失败: %s", library, e)
            return []

        if not isinstance(payload, dict):
            return []

        results = payload.get(library, []) or []
        if not isinstance(results, list):
            return []

        records: list[dict] = []
        for entry in results:
            if not isinstance(entry, list) or len(entry) < 7:
                continue
            # 按位置索引提取字段
            # 0: rank, 1: term_name, 2: p_value, 3: z_score,
            # 4: combined_score, 5: overlapping_genes, 6: adj_p_value
            fields = {
                "term": entry[1],
                "p_value": entry[2],
                "adj_p_value": entry[6],
                "z_score": entry[3],
                "combined_score": entry[4],
                "overlapping_genes": entry[5],
                "library": library,
            }
            rec_url = f"{self.base_url}/enrich?dataset={library}"
            rec = make_record(
                task_id, "enrichr", fields, query,
                url=rec_url, confidence=0.9,
            )
            records.append(rec)
            if len(records) >= max_results:
                break
        return records

    def _delete_list(self, user_list_id: int) -> None:
        """DELETE /view?userListId={id} 清理基因列表（best-effort，失败忽略）。"""
        url = f"{self.base_url}/view"
        params = {"userListId": user_list_id}
        try:
            self.limiter.wait()
            r = self.client.delete(url, params=params)
            r.raise_for_status()
        except Exception as e:
            logger.debug(
                "enrichr: 清理 userListId=%s 失败（忽略）: %s",
                user_list_id, e,
            )
