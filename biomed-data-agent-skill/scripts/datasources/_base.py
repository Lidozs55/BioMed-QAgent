"""数据源客户端公共基类与工具。

提供：
- BaseDataSource 抽象基类，定义统一 search 接口
- RateLimiter 简单限速器（默认 1 req/sec）
- make_record 工具函数，构造符合 data_record.schema.json 的记录
- json_stdout / write_output / emit_error 输出工具
- setup_cli 命令行参数构造器
- 各数据源 API base URL 常量
"""
from __future__ import annotations

import abc
import argparse
import hashlib
import json
import sys
import time
from datetime import datetime
from typing import Any, Iterable

# ===== API base URL 常量 =====
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
    return datetime.utcnow().isoformat() + "Z"


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


class BaseDataSource(abc.ABC):
    """数据源客户端抽象基类。"""

    name: str = "base"

    def __init__(self, rate: float = 1.0):
        self.limiter = RateLimiter(rate)

    @abc.abstractmethod
    def search(self, query: str, max_results: int = 20) -> list[dict]:
        """执行检索，返回 DataRecord 列表。"""
        raise NotImplementedError


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


def json_stdout(records: Iterable[dict]) -> None:
    """把记录列表以 JSON 输出到 stdout。"""
    records = list(records)
    payload = {"status": "ok", "records": records, "count": len(records)}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str))
    sys.stdout.write("\n")
    sys.stdout.flush()


def emit_error(message: str) -> None:
    """输出错误 JSON 到 stdout。"""
    sys.stdout.write(json.dumps({"status": "error", "message": message}, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def log_stderr(msg: str) -> None:
    """日志输出到 stderr。"""
    sys.stderr.write(f"[datasource] {msg}\n")
    sys.stderr.flush()


def setup_cli(name: str, description: str) -> argparse.ArgumentParser:
    """构造统一参数解析器，预设 --query/--max/--out/--task-id。"""
    parser = argparse.ArgumentParser(prog=name, description=description)
    parser.add_argument("--query", "-q", required=False, default="", help="检索查询串")
    parser.add_argument("--max", "-m", type=int, default=20, help="最大返回记录数")
    parser.add_argument("--out", "-o", default=None, help="输出 JSON 文件路径；不指定则输出到 stdout")
    parser.add_argument("--task-id", "-t", default="default", help="任务 ID")
    return parser


def write_output(records: list[dict], out_path: str | None) -> None:
    """根据 --out 决定输出到文件或 stdout。"""
    payload = {"status": "ok", "records": records, "count": len(records)}
    text = json.dumps(payload, ensure_ascii=False, default=str)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()
