"""PubChem 化合物结构检索客户端。

API: PubChem PUG REST
端点: https://pubchem.ncbi.nlm.nih.gov/rest/pug
  - /compound/name/{name}/JSON         按名称查化合物
  - /compound/cid/{cid}/property/.../JSON  查 SMILES/分子量/IUPAC 名
  - /compound/cid/{cid}/synonyms/JSON  查同义词
限速: 1 req/sec（PubChem 允许 5 req/sec，保守取 1）

用法:
    from app.tools.datasources.pubchem import search_pubchem
    records = search_pubchem("aspirin", max_results=10, task_id="task1")
"""
from __future__ import annotations

import logging
from urllib.parse import quote

try:
    import requests
except ImportError:  # pragma: no cover - 优雅降级
    requests = None  # type: ignore[assignment]

from .base_ds import (
    PUBCHEM_URL,
    RateLimiter,
    make_record,
)

logger = logging.getLogger(__name__)

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
        logger.warning("pubchem: 获取 cid=%s 同义词失败: %s", cid, e)
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
