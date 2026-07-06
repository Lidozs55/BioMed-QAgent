"""DisGeNET 基因-疾病关联检索客户端。

API: DisGeNET REST API
端点: https://www.disgenet.org/api/gda
限速: 1 req/sec
认证: 需要 API key，从环境变量 DISGENET_API_KEY 读取

检索模式:
  - gene:    按基因 symbol 检索关联疾病（geneId2disease）
  - disease: 按疾病名称/CUI 检索关联基因（disease2geneId）

用法:
    python scripts/datasources/disgenet_client.py --query "TP53" --mode gene --max 20 --out result.json
    python scripts/datasources/disgenet_client.py --query "Breast Cancer" --mode disease --max 20
"""
from __future__ import annotations

import os
import sys

try:
    import requests
except ImportError:  # pragma: no cover - 优雅降级
    requests = None  # type: ignore[assignment]

from _base import (
    DISGENET_URL,
    RateLimiter,
    emit_error,
    log_stderr,
    make_record,
    setup_cli,
    write_output,
)

HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def _auth_headers() -> dict:
    """构造带 API key 的请求头；缺失 key 时返回 None 哨兵。"""
    api_key = os.environ.get("DISGENET_API_KEY", "").strip()
    if not api_key:
        return None  # type: ignore[return-value]
    h = dict(HEADERS)
    h["Authorization"] = api_key
    return h


def search_disgenet(query: str, mode: str, max_results: int, task_id: str) -> list[dict]:
    headers = _auth_headers()
    if headers is None:
        raise RuntimeError("缺少环境变量 DISGENET_API_KEY，无法访问 DisGeNET API")
    limiter = RateLimiter(1.0)
    limiter.wait()
    # gene 模式按 gene_symbol 检索；disease 模式按 disease 检索
    if mode == "disease":
        params = {"disease": query, "source": "CURATED", "format": "json", "limit": max_results}
    else:
        params = {"gene_symbol": query, "source": "CURATED", "format": "json", "limit": max_results}
    r = requests.get(DISGENET_URL, params=params, headers=headers, timeout=60)
    r.raise_for_status()
    payload = r.json()
    # DisGeNET 返回可能是列表或 {"payload": [...]} 结构
    if isinstance(payload, dict):
        items = payload.get("payload", []) or payload.get("results", []) or []
    elif isinstance(payload, list):
        items = payload
    else:
        items = []
    records = []
    for it in items:
        if not isinstance(it, dict):
            continue
        gene_symbol = it.get("gene_symbol", "") or ""
        gene_id = it.get("geneid", "") or ""
        disease = it.get("disease_name", "") or ""
        disease_id = it.get("diseaseid", "") or ""
        fields = {
            "gene_symbol": gene_symbol,
            "gene_id": str(gene_id),
            "ncbi_gene_id": str(gene_id),
            "disease": disease,
            "disease_id": disease_id,
            "score": it.get("score", 0.0) or 0.0,
            "source": it.get("source", "") or "",
            "year_publication": it.get("year_publication", "") or "",
        }
        url = f"https://www.disgenet.org/gene/{gene_id}" if gene_id else None
        rec = make_record(
            task_id, "disgenet", fields, query,
            url=url, accession=str(gene_id) or None, confidence=0.9,
        )
        records.append(rec)
    return records


def main() -> None:
    parser = setup_cli("disgenet_client", "DisGeNET 基因-疾病关联检索")
    parser.add_argument(
        "--mode", default="gene", choices=["gene", "disease"],
        help="检索模式：gene（基因->疾病）或 disease（疾病->基因），默认 gene",
    )
    args = parser.parse_args()
    if requests is None:
        emit_error("requests 库不可用，请安装 requests")
        sys.exit(1)
    if not args.query:
        emit_error("缺少 --query 参数")
        sys.exit(1)
    if _auth_headers() is None:
        # 无 API Key 时优雅降级：输出空记录而非报错，避免阻塞流水线
        log_stderr("disgenet: 未配置 DISGENET_API_KEY，跳过（输出空记录）")
        write_output([], args.out)
        sys.exit(0)
    try:
        records = search_disgenet(args.query, args.mode, args.max, args.task_id)
        write_output(records, args.out)
        log_stderr(f"disgenet/{args.mode}: 返回 {len(records)} 条关联")
    except Exception as e:
        emit_error(f"disgenet 检索失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
