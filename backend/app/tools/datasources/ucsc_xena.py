"""UCSC Xena 数据源插件。

通过 UCSC Xena 平台检索多组学矩阵数据集（TCGA / GTEx / CCLE 等）。
Xena Hub: https://toil.xenabrowser.net

Xena Hub 采用类 GraphQL 的自定义协议：通过 POST /data/ 提交 Lisp 风格的
查询字符串（Content-Type: text/plain）获取数据集元数据。由于该协议较复杂
且字段布局随 hub 变化，本实现采用任务允许的简化策略：

1. 预定义常用 TCGA 肿瘤类型 → Xena dataset 映射字典（含关键词与近似样本数）
2. 按关键词（如 "BRCA" / "breast cancer" / "乳腺癌"）匹配预定义数据集
3. 可选通过 _post_raw 调用 Xena /data/ 端点获取实时样本数（fetch_meta=True），
   失败时回退到预设信息，保证检索鲁棒。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from app.tools.datasources.base_ds import BaseDataSource, make_record

logger = logging.getLogger(__name__)


class UCSCXenaSource(BaseDataSource):
    """UCSC Xena 多组学矩阵数据源。

    匹配 TCGA 肿瘤类型缩写或名称关键词，返回该肿瘤类型下常用组学数据集
    （RNAseq 表达 / 突变 / DNA 甲基化 / 拷贝数变异 / 临床信息）。
    """

    name: str = "ucsc_xena"
    description: str = "UCSC Xena 多组学矩阵数据"
    base_url: str = "https://toil.xenabrowser.net"
    default_rate: float = 1.0

    # TCGA 数据所在 hub
    _TCGA_HUB: str = "https://tcga.xenahubs.net"

    # 预定义 TCGA 肿瘤类型映射
    # 每项: 缩写、全称、近似样本数（HiSeqV2 主队列，公开已知值）、匹配关键词
    _TCGA_CANCERS: list[dict[str, Any]] = [
        {"abbr": "BRCA", "name": "Breast Invasive Carcinoma", "n": 1097,
         "keywords": ["brca", "breast", "乳腺癌"]},
        {"abbr": "LUAD", "name": "Lung Adenocarcinoma", "n": 513,
         "keywords": ["luad", "lung adenocarcinoma", "肺腺癌"]},
        {"abbr": "LUSC", "name": "Lung Squamous Cell Carcinoma", "n": 504,
         "keywords": ["lusc", "lung squamous", "肺鳞癌"]},
        {"abbr": "PRAD", "name": "Prostate Adenocarcinoma", "n": 497,
         "keywords": ["prad", "prostate", "前列腺癌"]},
        {"abbr": "COAD", "name": "Colon Adenocarcinoma", "n": 459,
         "keywords": ["coad", "colon", "结肠癌"]},
        {"abbr": "READ", "name": "Rectum Adenocarcinoma", "n": 161,
         "keywords": ["read", "rectum", "直肠癌"]},
        {"abbr": "SKCM", "name": "Skin Cutaneous Melanoma", "n": 448,
         "keywords": ["skcm", "melanoma", "黑色素瘤"]},
        {"abbr": "BLCA", "name": "Bladder Urothelial Carcinoma", "n": 408,
         "keywords": ["blca", "bladder", "膀胱癌"]},
        {"abbr": "LIHC", "name": "Liver Hepatocellular Carcinoma", "n": 371,
         "keywords": ["lihc", "liver", "肝癌"]},
        {"abbr": "HNSC", "name": "Head and Neck Squamous Cell Carcinoma", "n": 500,
         "keywords": ["hnsc", "head and neck", "头颈鳞癌"]},
        {"abbr": "KIRC", "name": "Kidney Renal Clear Cell Carcinoma", "n": 515,
         "keywords": ["kirc", "kidney clear cell", "肾透明细胞癌"]},
        {"abbr": "KIRP", "name": "Kidney Renal Papillary Cell Carcinoma", "n": 289,
         "keywords": ["kirp", "kidney papillary", "肾乳头状癌"]},
        {"abbr": "OV", "name": "Ovarian Serous Cystadenocarcinoma", "n": 379,
         "keywords": ["ov", "ovarian", "卵巢癌"]},
        {"abbr": "GBM", "name": "Glioblastoma Multiforme", "n": 154,
         "keywords": ["gbm", "glioblastoma", "brain", "胶质母细胞瘤"]},
        {"abbr": "LGG", "name": "Brain Lower Grade Glioma", "n": 511,
         "keywords": ["lgg", "lower grade glioma", "brain", "glioma", "低级别胶质瘤"]},
        {"abbr": "LAML", "name": "Acute Myeloid Leukemia", "n": 150,
         "keywords": ["laml", "aml", "leukemia", "急性髓系白血病"]},
        {"abbr": "THCA", "name": "Thyroid Carcinoma", "n": 500,
         "keywords": ["thca", "thyroid", "甲状腺癌"]},
        {"abbr": "UCEC", "name": "Uterine Corpus Endometrial Carcinoma", "n": 548,
         "keywords": ["ucec", "endometrial", "子宫内膜癌"]},
        {"abbr": "CESC", "name": "Cervical Squamous Cell Carcinoma", "n": 304,
         "keywords": ["cesc", "cervical", "宫颈癌"]},
        {"abbr": "PAAD", "name": "Pancreatic Adenocarcinoma", "n": 177,
         "keywords": ["paad", "pancreatic", "胰腺癌"]},
        {"abbr": "ESCA", "name": "Esophageal Carcinoma", "n": 184,
         "keywords": ["esca", "esophageal", "食管癌"]},
        {"abbr": "STAD", "name": "Stomach Adenocarcinoma", "n": 414,
         "keywords": ["stad", "stomach", "胃癌"]},
        {"abbr": "ACC", "name": "Adrenocortical Carcinoma", "n": 79,
         "keywords": ["acc", "adrenocortical", "肾上腺皮质癌"]},
        {"abbr": "MESO", "name": "Mesothelioma", "n": 86,
         "keywords": ["meso", "mesothelioma", "间皮瘤"]},
        {"abbr": "UVM", "name": "Uveal Melanoma", "n": 80,
         "keywords": ["uvm", "uveal", "葡萄膜黑色素瘤"]},
        {"abbr": "CHOL", "name": "Cholangiocarcinoma", "n": 36,
         "keywords": ["chol", "cholangio", "胆管癌"]},
        {"abbr": "TGCT", "name": "Testicular Germ Cell Tumors", "n": 150,
         "keywords": ["tgct", "testicular", "睾丸癌"]},
        {"abbr": "THYM", "name": "Thymoma", "n": 124,
         "keywords": ["thym", "thymoma", "胸腺瘤"]},
        {"abbr": "PCPG", "name": "Pheochromocytoma and Paraganglioma", "n": 179,
         "keywords": ["pcpg", "pheochromocytoma", "嗜铬细胞瘤"]},
        {"abbr": "DLBC", "name": "Diffuse Large B-cell Lymphoma", "n": 48,
         "keywords": ["dlbc", "lymphoma", "淋巴瘤"]},
        {"abbr": "UCS", "name": "Uterine Carcinosarcoma", "n": 57,
         "keywords": ["ucs", "uterine carcinosarcoma", "子宫癌肉瘤"]},
    ]

    # 每个肿瘤类型下常见的组学数据类型
    # (后缀模板, 子数据类型, 平台, 描述)；{abbr} 占位符用于临床数据集命名
    _DATATYPES: list[tuple[str, str, str, str]] = [
        ("HiSeqV2", "gene_expression", "Illumina HiSeq",
         "RNAseq gene expression (Hugo normalized count)"),
        ("GDC_AggregateIMPACTNonsilent_Mut", "mutation", "Mutect2",
         "Aggregated non-silent mutations"),
        ("methylation450", "dna_methylation", "Illumina 450K",
         "DNA methylation (450K)"),
        ("GDC_AggregateCNV", "copy_number_variation", "GDC CNV",
         "Gene-level copy number variation"),
        ("{abbr}_clinicalMatrix", "clinical", "Clinical",
         "Patient clinical data matrix"),
    ]

    def _match_cancers(self, query: str) -> list[dict[str, Any]]:
        """根据 query 关键词匹配 TCGA 肿瘤类型，返回命中项列表。

        匹配规则（不区分大小写）：
        1. query 完全等于缩写 → 命中
        2. query 包含某关键词 → 命中（如 "breast cancer" 含 "breast"）
        3. 关键词包含 query（query 长度>=3）→ 命中（如 "lung" 命中 "lung adenocarcinoma"）
        无命中返回空列表。
        """
        if not query:
            return []
        q = query.strip().lower()
        matched: list[dict[str, Any]] = []
        for cancer in self._TCGA_CANCERS:
            if q == cancer["abbr"].lower():
                matched.append(cancer)
                continue
            for kw in cancer["keywords"]:
                if kw in q or (len(q) >= 3 and q in kw):
                    matched.append(cancer)
                    break
        return matched

    def _dataset_url(self, dataset_id: str) -> str:
        """构造 Xena 数据集可视化页面 URL。"""
        return (
            f"https://xenabrowser.net/datapages/?dataset={dataset_id}"
            f"&host={self._TCGA_HUB}"
        )

    def _fetch_dataset_meta(self, dataset_id: str) -> dict[str, Any]:
        """通过 Xena API 查询数据集元数据（best-effort）。

        Xena 协议：POST /data/，body 为 Lisp 风格查询字符串，
        Content-Type: text/plain。metadata 查询返回 JSON 数组，
        第一项为字段名列表，后续为对应值。

        失败时返回空 dict（不抛异常），调用方回退到预设信息。
        """
        body = f'(metadata\n\t\t"{dataset_id}"\n\t\t\t\t)'
        try:
            text = self._post_raw(
                f"{self.base_url}/data/",
                content=body,
                headers={"Content-Type": "text/plain"},
            )
            return self._parse_xena_response(text)
        except Exception as e:
            logger.debug("ucsc_xena: 获取 %s 元数据失败: %s", dataset_id, e)
            return {}

    @staticmethod
    def _parse_xena_response(text: str) -> dict[str, Any]:
        """解析 Xena 响应文本为 dict。失败返回 {}。

        Xena metadata 响应形如:
        [["name", "title", "labels", "type", ...], [...values...]]
        """
        try:
            arr = json.loads(text)
        except Exception:
            return {}
        if not isinstance(arr, list) or len(arr) < 2:
            return {}
        keys = arr[0] if isinstance(arr[0], list) else []
        values = arr[1] if isinstance(arr[1], list) else []
        if not keys or not values:
            return {}
        return dict(zip(keys, values))

    def search(
        self,
        query: str,
        max_results: int = 20,
        task_id: str = "default",
        **kwargs: Any,
    ) -> list[dict]:
        """按关键词检索 UCSC Xena 多组学数据集。

        匹配 TCGA 肿瘤类型缩写或名称关键词（如 "BRCA"、"breast cancer"、
        "肺癌"），返回该肿瘤类型下的常用组学数据集记录（RNAseq 表达 / 突变 /
        DNA 甲基化 / 拷贝数变异 / 临床信息）。

        Args:
            query: 关键词（如 "BRCA"、"breast cancer"、"肺癌"）。
            max_results: 最多返回记录数。
            task_id: 关联任务 ID。
            **kwargs:
                fetch_meta: 是否通过 Xena API 获取实时样本数（默认 False，
                    使用预设近似值以保证检索速度与鲁棒性）。

        Returns:
            DataRecord 列表，每条记录描述一个 Xena 数据集。
        """
        if not query or not query.strip():
            return []
        fetch_meta = bool(kwargs.get("fetch_meta", False))
        matched = self._match_cancers(query)
        if not matched:
            logger.debug("ucsc_xena: 无匹配肿瘤类型 query=%s", query)
            return []

        records: list[dict] = []
        for cancer in matched:
            abbr: str = cancer["abbr"]
            full: str = cancer["name"]
            preset_n = cancer["n"]
            sample_map = f"TCGA.{abbr}.sampleMap"
            for suffix_tpl, dtype, platform, desc in self._DATATYPES:
                if len(records) >= max_results:
                    break
                dataset_id = f"{sample_map}/{suffix_tpl.format(abbr=abbr)}"

                # 样本数：优先 API 实时查询，回退预设近似值
                sample_count = str(preset_n)
                if fetch_meta:
                    meta = self._fetch_dataset_meta(dataset_id)
                    if meta:
                        live = (
                            meta.get("data")
                            or meta.get("samples")
                            or meta.get("sample_count")
                        )
                        if live:
                            sample_count = str(live)

                fields = {
                    "dataset_id": dataset_id,
                    "dataset_name": f"{full} - {desc}",
                    "data_type": dtype,
                    "label": f"{abbr} {dtype}",
                    "platform": platform,
                    "sample_count": sample_count,
                    "cancer_type": abbr,
                    "cancer_name": full,
                    "hub": self._TCGA_HUB,
                }
                rec = make_record(
                    task_id=task_id,
                    source_name=self.name,
                    fields=fields,
                    query=query,
                    url=self._dataset_url(dataset_id),
                    accession=dataset_id,
                    confidence=0.85,
                    method="api",
                )
                records.append(rec)
            if len(records) >= max_results:
                break
        return records[:max_results]
