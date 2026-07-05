"""ClinicalTrials.gov 临床试验检索客户端。

API: ClinicalTrials.gov v2 API
端点: https://clinicaltrials.gov/api/v2/studies
限速: 1 req/sec

用法:
    python scripts/datasources/clinicaltrials_client.py --query "pancreatic cancer" --max 20 --out result.json
"""
from __future__ import annotations

import sys

try:
    import requests
except ImportError:  # pragma: no cover - 优雅降级
    requests = None  # type: ignore[assignment]

from _base import (
    CLINICALTRIALS_URL,
    RateLimiter,
    emit_error,
    log_stderr,
    make_record,
    setup_cli,
    write_output,
)

HEADERS = {"User-Agent": "BioMedQAgent/1.0"}


def _first(value) -> str:
    """从字符串或列表中取第一个非空元素。"""
    if isinstance(value, list):
        return value[0] if value else ""
    return str(value or "")


def search_clinicaltrials(query: str, max_results: int, task_id: str) -> list[dict]:
    limiter = RateLimiter(1.0)
    limiter.wait()
    params = {"query.expr": query, "pageSize": max_results}
    r = requests.get(CLINICALTRIALS_URL, params=params, headers=HEADERS, timeout=60)
    r.raise_for_status()
    data = r.json()
    studies = data.get("studies", []) or []
    records = []
    for st in studies:
        proto = st.get("protocolSection", {}) or {}
        ident = proto.get("identificationModule", {}) or {}
        status = proto.get("statusModule", {}) or {}
        cond = proto.get("conditionsModule", {}) or {}
        interv = proto.get("interventionsModule", {}) or {}
        spon = proto.get("sponsorCollaboratorsModule", {}) or {}
        design = proto.get("designModule", {}) or {}
        nct_id = ident.get("nctId", "") or ""
        interventions = []
        for it in interv.get("interventions", []) or []:
            name = it.get("name", "") or it.get("type", "")
            if name:
                interventions.append(name)
        lead = spon.get("leadSponsor", {}) or {}
        enroll_info = design.get("enrollmentInfo", {}) or {}
        start_struct = status.get("startDateStruct", {}) or {}
        compl_struct = status.get("completionDateStruct", {}) or {}
        fields = {
            "nct_id": nct_id,
            "brief_title": ident.get("briefTitle", "") or "",
            "official_title": ident.get("officialTitle", "") or "",
            "overall_status": status.get("overallStatus", "") or "",
            "condition": _first(cond.get("conditions", [])),
            "conditions": cond.get("conditions", []) or [],
            "intervention": _first(interventions),
            "interventions": interventions,
            "phase": _first(design.get("phases", [])),
            "phases": design.get("phases", []) or [],
            "sponsor": lead.get("name", "") or "",
            "start_date": start_struct.get("date", "") or "",
            "completion_date": compl_struct.get("date", "") or "",
            "enrollment": enroll_info.get("count", 0) or 0,
            "study_type": design.get("studyType", "") or "",
        }
        url = f"https://clinicaltrials.gov/study/{nct_id}" if nct_id else None
        rec = make_record(
            task_id, "clinicaltrials", fields, query,
            url=url, accession=nct_id or None, confidence=1.0,
        )
        records.append(rec)
    return records


def main() -> None:
    parser = setup_cli("clinicaltrials_client", "ClinicalTrials.gov 临床试验检索（v2 API）")
    args = parser.parse_args()
    if requests is None:
        emit_error("requests 库不可用，请安装 requests")
        sys.exit(1)
    if not args.query:
        emit_error("缺少 --query 参数")
        sys.exit(1)
    try:
        records = search_clinicaltrials(args.query, args.max, args.task_id)
        write_output(records, args.out)
        log_stderr(f"clinicaltrials: 返回 {len(records)} 条试验")
    except Exception as e:
        emit_error(f"clinicaltrials 检索失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
