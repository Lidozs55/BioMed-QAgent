"""KEGG 通路检索客户端。

API: KEGG REST API
端点: https://rest.kegg.jp
限速: 1 req/sec（KEGG 建议 3 req/sec，保守取 1）

流程: find/pathway/<query> 获取候选通路 -> get/<pathway_id> 解析 flat 格式
用法:
    python scripts/datasources/kegg_client.py --query "cell cycle" --species hsa --out result.json
"""
from __future__ import annotations

import sys
from urllib.parse import quote

import requests

from _base import (
    KEGG_URL,
    RateLimiter,
    emit_error,
    log_stderr,
    make_record,
    setup_cli,
    write_output,
)

HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def _parse_tsv(text: str) -> list[tuple[str, str]]:
    rows = []
    for line in text.strip().splitlines():
        if "\t" in line:
            a, b = line.split("\t", 1)
            rows.append((a.strip(), b.strip()))
    return rows


def _parse_kegg_entry(text: str) -> dict[str, str]:
    """解析 KEGG get 返回的 flat 格式（字段名顶格，续行缩进）。"""
    sections: dict[str, str] = {}
    current = None
    for line in text.splitlines():
        if not line.strip():
            continue
        if line[:1] != " ":
            parts = line.split(None, 1)
            current = parts[0]
            sections[current] = parts[1] if len(parts) > 1 else ""
        elif current:
            sections[current] += "\n" + line.strip()
    return sections


def search_kegg(query: str, species: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    # 1. find/pathway/<query> 获取候选通路
    limiter.wait()
    r = requests.get(f"{KEGG_URL}/find/pathway/{quote(query)}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    candidates = _parse_tsv(r.text)
    # 优先物种特异性通路（前缀如 hsa），回退到参考通路 map
    org_paths = [(pid, title) for pid, title in candidates if pid.startswith(species)]
    if not org_paths:
        org_paths = [(pid, title) for pid, title in candidates if pid.startswith("map")]
    records = []
    for pid, title in org_paths[:max_results]:
        limiter.wait()
        r = requests.get(f"{KEGG_URL}/get/{pid}", headers=HEADERS, timeout=30)
        r.raise_for_status()
        sec = _parse_kegg_entry(r.text)
        # 解析基因与化合物
        genes = []
        for gl in sec.get("GENE", "").splitlines():
            parts = gl.split(None, 2)
            if len(parts) >= 2:
                genes.append(parts[1].split(";")[0])
        compounds = [cl.split(None, 1)[0] for cl in sec.get("COMPOUND", "").splitlines() if cl.strip()]
        name = sec.get("NAME", title).split(";")[0].strip() if sec.get("NAME") else title
        fields = {
            "pathway_id": pid,
            "title": name,
            "description": sec.get("DESCRIPTION", ""),
            "genes": genes,
            "compounds": compounds,
            "class": sec.get("CLASS", ""),
        }
        url = f"https://www.kegg.jp/entry/{pid}"
        rec = make_record(task_id, "kegg", fields, query, url=url, accession=pid, confidence=1.0)
        records.append(rec)
    return records


def main() -> None:
    parser = setup_cli("kegg_client", "KEGG 通路检索（REST API）")
    parser.add_argument("--species", "-s", default="hsa", help="物种 KEGG 代码（默认 hsa 人）")
    args = parser.parse_args()
    if not args.query:
        emit_error("缺少 --query 参数")
        sys.exit(1)
    try:
        records = search_kegg(args.query, args.species, args.max, args.task_id)
        write_output(records, args.out)
        log_stderr(f"kegg: 返回 {len(records)} 条通路")
    except Exception as e:
        emit_error(f"kegg 检索失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
