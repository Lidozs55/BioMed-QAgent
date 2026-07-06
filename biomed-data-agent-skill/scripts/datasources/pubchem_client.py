"""PubChem 化合物结构检索客户端。

API: PubChem PUG REST
端点: https://pubchem.ncbi.nlm.nih.gov/rest/pug
  - /compound/name/{name}/JSON         按名称查化合物
  - /compound/cid/{cid}/property/.../JSON  查 SMILES/分子量/IUPAC 名
  - /compound/cid/{cid}/synonyms/JSON  查同义词
限速: 1 req/sec（PubChem 允许 5 req/sec，保守取 1）

用法:
    python scripts/datasources/pubchem_client.py --query "aspirin" --max 10 --out result.json
"""
from __future__ import annotations

import sys
from urllib.parse import quote

try:
    import requests
except ImportError:  # pragma: no cover - 优雅降级
    requests = None  # type: ignore[assignment]

from _base import (
    PUBCHEM_URL,
    RateLimiter,
    emit_error,
    log_stderr,
    make_record,
    setup_cli,
    write_output,
)

COMPOUND_URL = f"{PUBCHEM_URL}/compound"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}
PROPERTY_LIST = "CanonicalSMILES,MolecularWeight,IUPACName"


def _get_cids(name: str, limiter: RateLimiter) -> list[int]:
    """按名称查询化合物，返回 CID 列表。"""
    limiter.wait()
    url = f"{COMPOUND_URL}/name/{quote(name)}/JSON"
    r = requests.get(url, headers=HEADERS, timeout=60)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    data = r.json()
    compounds = data.get("PC_Compounds", []) or []
    cids = []
    for c in compounds:
        cid = (c.get("id", {}) or {}).get("id", {}).get("cid")
        if cid:
            cids.append(int(cid))
    return cids


def _get_properties(cid: int, limiter: RateLimiter) -> dict:
    """查询单个 CID 的 SMILES/分子量/IUPAC 名。"""
    limiter.wait()
    url = f"{COMPOUND_URL}/cid/{cid}/property/{PROPERTY_LIST}/JSON"
    r = requests.get(url, headers=HEADERS, timeout=60)
    if r.status_code != 200:
        return {}
    props = r.json().get("PropertyTable", {}).get("Properties", []) or []
    return props[0] if props else {}


def _get_synonyms(cid: int, limiter: RateLimiter, limit: int = 10) -> list[str]:
    """查询单个 CID 的同义词（best-effort，失败返回空列表）。"""
    limiter.wait()
    url = f"{COMPOUND_URL}/cid/{cid}/synonyms/JSON"
    try:
        r = requests.get(url, headers=HEADERS, timeout=60)
        if r.status_code != 200:
            return []
        info = r.json().get("InformationList", {}).get("Information", []) or []
        if info:
            syns = info[0].get("Synonym", []) or []
            return [str(s) for s in syns[:limit]]
    except Exception as e:
        log_stderr(f"pubchem: 获取 cid={cid} 同义词失败: {e}")
    return []


def search_pubchem(query: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    cids = _get_cids(query, limiter)
    if not cids:
        return []
    records = []
    for cid in cids[:max_results]:
        props = _get_properties(cid, limiter)
        synonyms = _get_synonyms(cid, limiter)
        smiles = props.get("CanonicalSMILES", "") or ""
        fields = {
            "compound_name": query,
            "canonical_smiles": smiles,
            "smiles": smiles,
            "pubchem_cid": cid,
            "molecular_weight": props.get("MolecularWeight", "") or "",
            "iupac_name": props.get("IUPACName", "") or "",
            "synonyms": synonyms,
        }
        url = f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}"
        rec = make_record(
            task_id, "pubchem", fields, query,
            url=url, accession=str(cid), confidence=1.0,
        )
        records.append(rec)
    return records


def main() -> None:
    parser = setup_cli("pubchem_client", "PubChem 化合物结构检索（PUG REST）")
    args = parser.parse_args()
    if requests is None:
        emit_error("requests 库不可用，请安装 requests")
        sys.exit(1)
    if not args.query:
        emit_error("缺少 --query 参数")
        sys.exit(1)
    try:
        records = search_pubchem(args.query, args.max, args.task_id)
        write_output(records, args.out)
        log_stderr(f"pubchem: 返回 {len(records)} 条化合物")
    except Exception as e:
        emit_error(f"pubchem 检索失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
