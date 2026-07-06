"""STRING 蛋白质互作网络检索客户端。

API: STRING DB
端点: https://string-db.org/api/json/network
限速: 1 req/sec

用法:
    python scripts/datasources/string_client.py --query "TP53" --species 9606 --max 50 --out result.json
"""
from __future__ import annotations

import sys

import requests

from _base import (
    STRING_URL,
    RateLimiter,
    emit_error,
    log_stderr,
    make_record,
    setup_cli,
    write_output,
)

NETWORK_URL = f"{STRING_URL}/json/network"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def search_string(query: str, species: int, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    limiter.wait()
    # 调用 /api/json/network 获取互作边
    params = {
        "identifier": query,
        "species": species,
        "limit": max_results,
        "caller_identity": "BioMedQAgent",
    }
    r = requests.get(NETWORK_URL, params=params, headers=HEADERS, timeout=60)
    if r.status_code == 400:
        # 非基因符号查询（如中文研究目标）会返回 400，优雅返回空
        log_stderr(f"string: 查询 '{query[:30]}' 不是有效基因符号（400），跳过")
        return []
    r.raise_for_status()
    items = r.json()
    records = []
    for it in items:
        protein_a = it.get("preferredName_A", "") or it.get("stringId_A", "")
        protein_b = it.get("preferredName_B", "") or it.get("stringId_B", "")
        score = it.get("score", 0.0)
        evidence = {
            "experimental": it.get("experimental", 0),
            "database": it.get("database", 0),
            "textmining": it.get("textmining", 0),
            "coexpression": it.get("coexpression", 0),
        }
        fields = {
            "protein_a": protein_a,
            "protein_b": protein_b,
            "score": score,
            "evidence": evidence,
            "species": species,
        }
        string_id_a = it.get("stringId_A", "")
        url = f"https://string-db.org/network/{string_id_a}" if string_id_a else None
        rec = make_record(
            task_id, "string", fields, query,
            url=url, confidence=0.95,
        )
        records.append(rec)
    return records


def main() -> None:
    parser = setup_cli("string_client", "STRING 蛋白质互作网络检索")
    parser.add_argument("--species", "-s", type=int, default=9606, help="物种 NCBI taxon ID（默认 9606 人）")
    args = parser.parse_args()
    if not args.query:
        emit_error("缺少 --query 参数")
        sys.exit(1)
    try:
        records = search_string(args.query, args.species, args.max, args.task_id)
        write_output(records, args.out)
        log_stderr(f"string: 返回 {len(records)} 条互作")
    except Exception as e:
        emit_error(f"string 检索失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
