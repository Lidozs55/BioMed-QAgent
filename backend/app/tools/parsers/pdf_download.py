"""pdf_download.py — 论文 PDF 下载器 + Europe PMC 全文 XML fallback。

用途：从 DataRecord 列表中筛出含 pdf_url 的记录，下载 PDF 到本地，
返回更新的记录（带 local_pdf_path 字段，供后续 pdf_table 解析使用）。
当 PDF 直链不可用时，用 Europe PMC fullTextXML API 获取全文 XML（按 PMCID）。

支持数据源：arXiv（pdf_url 字段）、PubMed/PMC（pmc_id 转 PMC PDF）、
OpenAlex/Semantic Scholar（best_oa_location.pdf_url）、Europe PMC（fullTextXML）。

下载策略：
- 仅下载 open access 的 PDF（无需订阅）
- 跳过无 pdf_url 或 paywall 的记录
- 限速 1 req/3s，避免触发反爬
- 文件名：{source}-{arxiv_id|pmid|doi_safe}.pdf
- Unpaywall/PMC 网络不可达时快速失败（5s timeout + 失败计数器）
- EPMC fullTextXML 作为最后 fallback（国内可用，返回 JATS XML 全文）

示例：
    from .pdf_download import run
    records = run("records.json", "./pdfs", max_download=5)
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; BioMedQAgent/1.0; "
                  "+https://github.com/BioMedQAgent)",
    "Accept": "application/pdf,*/*",
}
TIMEOUT = 30
INTERVAL_SEC = 3.0  # arXiv 建议 >=3s，其他源也保守

# Unpaywall 快速失败参数（避免网络不通时长时间卡死）
UNPAYWALL_TIMEOUT = 5  # 秒（原 15s，网络不通时 60 条 × 15s = 15min 卡死）
UNPAYWALL_MAX_FAILURES = 3  # 连续失败 N 次后跳过后续 DOI 查询

# Europe PMC fullTextXML API（国内可用，按 PMCID 获取 JATS XML 全文）
EPMC_FULLTEXT_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML"
EPMC_TIMEOUT = 20


def _safe_filename(s: str) -> str:
    """转义字符串为安全文件名片段。"""
    return re.sub(r"[^\w.-]", "_", s)[:80] if s else "unknown"


def _extract_pdf_url(record: dict) -> str:
    """从 DataRecord 中提取 pdf_url。"""
    fields = record.get("fields", {}) if isinstance(record, dict) else {}
    # 直接字段
    if fields.get("pdf_url"):
        return fields["pdf_url"]
    # OpenAlex/Semantic Scholar 嵌套结构
    best_oa = fields.get("best_oa_location") or {}
    if isinstance(best_oa, dict) and best_oa.get("pdf_url"):
        return best_oa["pdf_url"]
    oa_locations = fields.get("open_access") or {}
    if isinstance(oa_locations, dict) and oa_locations.get("oa_url"):
        return oa_locations["oa_url"]
    return ""


def _unpaywall_pdf_url(doi: str) -> str:
    """通过 Unpaywall API 用 DOI 查询开放获取 PDF URL。

    Unpaywall 覆盖了所有有 DOI 的文献的 OA 状态，免费 API，
    限速 100k req/day，无需 Key（只需提供 email）。

    注意：api.unpaywall.org 在部分网络环境（如国内）可能 SSL 超时不可达，
    此处用 5s 快速失败，避免长时间卡死。
    """
    if not doi:
        return ""
    try:
        email = os.environ.get("OPENALEX_EMAIL", "biomed-qagent@example.com")
        url = f"https://api.unpaywall.org/v2/{doi}?email={email}"
        resp = requests.get(url, timeout=UNPAYWALL_TIMEOUT, headers=HEADERS)
        if resp.status_code != 200:
            return ""
        data = resp.json()
        # best_oa_location 是最优先的 OA 位置
        best_oa = data.get("best_oa_location") or {}
        if isinstance(best_oa, dict):
            pdf_url = best_oa.get("url_for_pdf") or best_oa.get("url")
            if pdf_url:
                return pdf_url
        # 遍历所有 OA 位置
        for loc in data.get("oa_locations", []):
            if isinstance(loc, dict):
                pdf_url = loc.get("url_for_pdf") or loc.get("url")
                if pdf_url:
                    return pdf_url
        return ""
    except Exception as e:
        logger.debug("Unpaywall 查询 %s 失败: %s", doi, e)
        return ""


def _epmc_fulltext_xml(pmcid: str) -> str:
    """通过 Europe PMC API 用 PMCID 获取全文 JATS XML。

    Europe PMC (ebi.ac.uk) 国内可访问，fullTextXML API 返回结构化 JATS XML，
    含 abstract/body/figures 等全文内容。作为 PDF 下载不可用时的 fallback。

    Args:
        pmcid: PMC ID，如 "PMC12681694"
    Returns:
        XML 全文字符串，失败返回空串
    """
    if not pmcid:
        return ""
    try:
        url = EPMC_FULLTEXT_URL.format(pmcid=pmcid)
        resp = requests.get(url, timeout=EPMC_TIMEOUT, headers=HEADERS)
        if resp.status_code != 200:
            return ""
        return resp.text
    except Exception as e:
        logger.debug("EPMC fullTextXML %s 失败: %s", pmcid, e)
        return ""


def _derive_id(record: dict) -> str:
    """从记录中取一个稳定的标识符作为文件名。"""
    fields = record.get("fields", {})
    for key in ("arxiv_id", "pmid", "pmcid", "doi", "openalex_id"):
        val = fields.get(key)
        if val:
            return _safe_filename(str(val))
    return record.get("record_id", "unknown").replace("/", "_")


def download_pdf(url: str, out_path: Path) -> bool:
    """下载单个 PDF。返回是否成功。"""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT, stream=True,
                            allow_redirects=True)
        if resp.status_code != 200:
            logger.warning("HTTP %s: %s", resp.status_code, url[:80])
            return False
        ctype = resp.headers.get("Content-Type", "").lower()
        if "pdf" not in ctype and not url.lower().endswith(".pdf"):
            logger.warning("非 PDF 内容 (Content-Type=%s): %s", ctype, url[:60])
            return False
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        size_kb = out_path.stat().st_size / 1024
        logger.info("下载完成: %s (%.1f KB)", out_path.name, size_kb)
        return True
    except Exception as e:
        logger.warning("下载失败 %s: %s", url[:60], e)
        return False


def run(input_path: str, out_dir: str, max_download: int = 10,
        task_id: str = "") -> list[dict]:
    """读取 records JSON，下载 PDF，返回更新后的 records 列表。"""
    in_p = Path(input_path)
    if in_p.is_dir():
        records = []
        for fp in sorted(in_p.rglob("*.json")):
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                records.extend(data)
            elif isinstance(data, dict) and "records" in data:
                records.extend(data["records"])
            elif isinstance(data, dict):
                records.append(data)
    elif in_p.is_file():
        with open(in_p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            records = data
        elif isinstance(data, dict) and "records" in data:
            records = data["records"]
        elif isinstance(data, dict):
            records = [data]
        else:
            records = []
    else:
        raise FileNotFoundError(f"输入路径不存在: {input_path}")

    out_dir_p = Path(out_dir)
    out_dir_p.mkdir(parents=True, exist_ok=True)
    downloaded_records: list[dict] = []
    count = 0
    # Unpaywall 连续失败计数器（网络不通时快速跳过，避免长时间卡死）
    unpaywall_failures = 0
    unpaywall_disabled = False
    for r in records:
        if count >= max_download:
            break
        fields = r.get("fields", {}) or {}
        url = _extract_pdf_url(r)
        if not url:
            # Fallback 1: 通过 Unpaywall 用 DOI 查询 OA PDF URL
            doi = fields.get("doi", "")
            if doi and not unpaywall_disabled:
                url = _unpaywall_pdf_url(doi)
                if not url:
                    unpaywall_failures += 1
                    if unpaywall_failures >= UNPAYWALL_MAX_FAILURES:
                        logger.warning(
                            "Unpaywall 连续失败 %d 次（网络不可达），"
                            "跳过后续 DOI 查询", unpaywall_failures)
                        unpaywall_disabled = True
            # Fallback 2: Europe PMC fullTextXML（国内可用，按 PMCID 获取全文 XML）
            if not url:
                pmcid = fields.get("pmcid", "")
                if pmcid:
                    xml_content = _epmc_fulltext_xml(pmcid)
                    if xml_content:
                        rid = _derive_id(r)
                        out_xml = out_dir_p / f"{rid}.xml"
                        out_xml.parent.mkdir(parents=True, exist_ok=True)
                        out_xml.write_text(xml_content, encoding="utf-8")
                        logger.info("EPMC 全文 XML 已保存: %s (%d KB)",
                                    out_xml.name, len(xml_content) // 1024)
                        r = dict(r)
                        r.setdefault("fields", {})
                        r["fields"]["local_pdf_path"] = str(out_xml)
                        r["fields"]["pdf_downloaded"] = True
                        r["fields"]["fulltext_format"] = "epmc_jats_xml"
                        downloaded_records.append(r)
                        count += 1
                        time.sleep(1.0)  # EPMC 限速保守
                continue
        rid = _derive_id(r)
        out_file = out_dir_p / f"{rid}.pdf"
        if out_file.exists() and out_file.stat().st_size > 1024:
            logger.info("已存在，跳过: %s", out_file.name)
        else:
            ok = download_pdf(url, out_file)
            if not ok:
                continue
            time.sleep(INTERVAL_SEC)
        # 更新记录，添加 local_pdf_path
        r = dict(r)
        r.setdefault("fields", {})
        r["fields"]["local_pdf_path"] = str(out_file)
        r["fields"]["pdf_downloaded"] = True
        downloaded_records.append(r)
        count += 1
    return downloaded_records
