"""_base.py — 公共基类与工具函数。

为 biomed-data-agent/scripts/parsers 下所有解析器提供共享基础设施：
- BaseParser 抽象基类（定义 parse(file_path) -> list[dict] 接口）
- make_record 工具函数（构造符合 DataRecord schema 的 dict）
- setup_cli 函数（返回预设 --input/--out/--task-id 的 argparse.ArgumentParser）
- detect_format 函数（根据扩展名 + magic bytes 检测格式）
- BIO_DATA_EXTENSIONS 常量（常见生物数据文件扩展名）

所有解析器脚本通过 ``import _base`` 引用本模块（脚本直接以
``python scripts/parsers/xxx.py`` 运行时，本目录会被加入 sys.path）。
"""
import argparse
import hashlib
import json
import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone


# 常见生物数据文件扩展名 -> 解析器标识
BIO_DATA_EXTENSIONS = {
    ".soft": "geo_soft",
    ".soft.gz": "geo_soft",
    ".pdb": "pdb",
    ".ent": "pdb",
    ".fasta": "fasta",
    ".fa": "fasta",
    ".faa": "fasta",
    ".fna": "fasta",
    ".fastq": "fasta",
    ".pdf": "pdf",
    ".tsv": "network",
    ".sif": "network",
    ".graphml": "graphml",
    ".xml": "graphml",
}


def _now_iso():
    """返回当前 UTC 时间的 ISO 8601 字符串。"""
    return datetime.now(timezone.utc).isoformat()


def _hash8(text):
    """对文本取 MD5 的前 8 位，用于生成 record_id。"""
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:8]


def make_record(task_id, source_name, fields, file_path,
                confidence=0.85, method="table", accession=None,
                source_type="file"):
    """构造一个符合 DataRecord schema 的 dict。

    :param task_id: 任务 ID（用于 provenance 追踪）
    :param source_name: 数据源标识（geo / pdb / fasta / pdf / network ...）
    :param fields: 提取出的字段 dict（字段名需为统一名）
    :param file_path: 原始文件路径
    :param confidence: 提取置信度 0~1
    :param method: extraction_method，取值 api/crawl/table/text/chart/manual
    :param accession: 数据库 accession（GSE12345 / 1AKI / 序列 ID 等）
    :param source_type: source_ref.source_type，取值 api/web_page/pdf/database/file/manual
    :return: DataRecord dict
    """
    seed = f"{source_name}:{file_path}:{accession or ''}:{json.dumps(fields, sort_keys=True, default=str)}"
    record_id = f"{source_name}-{_hash8(seed)}"
    source_ref = {
        "source_name": source_name,
        "source_type": source_type,
        "query": file_path,
        "retrieved_at": _now_iso(),
    }
    if accession:
        source_ref["source_accession"] = str(accession)
    return {
        "record_id": record_id,
        "task_id": task_id,
        "fields": fields,
        "source_ref": source_ref,
        "extraction_method": method,
        "extraction_confidence": confidence,
        "quality_flags": [],
        "created_at": _now_iso(),
    }


def setup_cli(name, description):
    """创建 argparse.ArgumentParser，预设 --input / --out / --task-id 通用参数。

    :param name: 程序名（prog）
    :param description: 一句话描述
    :return: argparse.ArgumentParser（子类可继续 add_argument）
    """
    parser = argparse.ArgumentParser(
        prog=name,
        description=description,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--input", required=True,
                        help="输入文件路径")
    parser.add_argument("--out", default=None,
                        help="输出 JSON 路径，省略则输出到 stdout")
    parser.add_argument("--task-id", default="default", dest="task_id",
                        help="任务 ID（用于 provenance 追踪）")
    return parser


def detect_format(file_path):
    """根据文件扩展名 + magic bytes 检测格式。

    :return: 格式字符串 geo_soft / pdb / fasta / pdf / network / graphml /
             sif / gzip_unknown / unknown
    """
    lower = file_path.lower()
    try:
        with open(file_path, "rb") as f:
            head = f.read(4)
    except OSError:
        head = b""
    # GEO SOFT
    if lower.endswith(".soft") or lower.endswith(".soft.gz"):
        return "geo_soft"
    # PDB
    if lower.endswith(".pdb") or lower.endswith(".ent"):
        return "pdb"
    # FASTA
    if lower.endswith((".fasta", ".fa", ".faa", ".fna", ".fastq")):
        return "fasta"
    # PDF（magic %PDF）
    if lower.endswith(".pdf") or head.startswith(b"%PDF"):
        return "pdf"
    # GraphML / XML
    if lower.endswith((".graphml", ".xml")):
        return "graphml"
    # SIF
    if lower.endswith(".sif"):
        return "sif"
    # TSV / network
    if lower.endswith((".tsv", ".txt", ".csv")):
        return "network"
    # gzip 但扩展名未知
    if head[:2] == b"\x1f\x8b":
        return "gzip_unknown"
    return "unknown"


def write_output(result, out_path=None):
    """将解析结果序列化为 JSON 写出。

    成功结构: {"status": "ok", "records": [...], "count": N}
    失败结构: {"status": "error", "message": "..."}
    """
    text = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    if out_path:
        out_dir = os.path.dirname(os.path.abspath(out_path))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        print(text)


def make_ok(records):
    """构造标准成功输出。"""
    return {"status": "ok", "records": records, "count": len(records)}


def make_error(message):
    """构造标准错误输出。"""
    return {"status": "error", "message": message}


class BaseParser(ABC):
    """解析器抽象基类。

    子类必须实现 ``parse(file_path) -> list[dict]``，返回 DataRecord 列表。
    解析过程中遇到单条记录异常应跳过并继续，不要整体 crash。
    """

    source_name = "base"

    @abstractmethod
    def parse(self, file_path):
        """解析文件，返回 DataRecord 列表。

        :param file_path: 输入文件路径
        :return: list[dict]，每个 dict 符合 DataRecord schema
        """
        raise NotImplementedError
