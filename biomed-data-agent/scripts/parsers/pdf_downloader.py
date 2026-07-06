#!/usr/bin/env python3
"""pdf_downloader.py — 论文 PDF 下载器。

用途：从 DataRecord 列表中筛出含 pdf_url 的记录，下载 PDF 到本地，
返回更新的记录（带 local_pdf_path 字段，供后续 pdf_table_parser 使用）。

支持数据源：arXiv（pdf_url 字段）、PubMed/PMC（pmc_id 转 PMC PDF）、
OpenAlex/Semantic Scholar（best_oa_location.pdf_url）。

下载策略：
- 仅下载 open access 的 PDF（无需订阅）
- 跳过无 pdf_url 或 paywall 的记录
- 限速 1 req/3s，避免触发反爬
- 文件名：{source}-{arxiv_id|pmid|doi_safe}.pdf

用法：
    python pdf_downloader.py --input records.json --out-dir ./pdfs --out downloaded.json
    python pdf_downloader.py --input records.json --out-dir ./pdfs --max 5
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

import requests

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import make_error, make_ok, setup_cli, write_output  # type: ignore


def log_stderr(msg: str) -> None:
    """日志输出到 stderr。"""
    sys.stderr.write(f"[pdf_downloader] {msg}\n")
    sys.stderr.flush()


def emit_error(message: str) -> None:
    """输出错误 JSON 到 stdout 并退出。"""
    sys.stdout.write(json.dumps({"status": "error", "message": message},
                                ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(1)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; BioMedQAgent/1.0; "
                  "+https://github.com/BioMedQAgent)",
    "Accept": "application/pdf,*/*",
}
TIMEOUT = 30
INTERVAL_SEC = 3.0  # arXiv 建议 >=3s，其他源也保守


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
            log_stderr(f"HTTP {resp.status_code}: {url[:80]}")
            return False
        ctype = resp.headers.get("Content-Type", "").lower()
        if "pdf" not in ctype and not url.lower().endswith(".pdf"):
            log_stderr(f"非 PDF 内容 (Content-Type={ctype}): {url[:60]}")
            return False
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        size_kb = out_path.stat().st_size / 1024
        log_stderr(f"下载完成: {out_path.name} ({size_kb:.1f} KB)")
        return True
    except Exception as e:
        log_stderr(f"下载失败 {url[:60]}: {e}")
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
    for r in records:
        if count >= max_download:
            break
        url = _extract_pdf_url(r)
        if not url:
            continue
        rid = _derive_id(r)
        out_file = out_dir_p / f"{rid}.pdf"
        if out_file.exists() and out_file.stat().st_size > 1024:
            log_stderr(f"已存在，跳过: {out_file.name}")
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


def main():
    parser = setup_cli("pdf_downloader", "论文 PDF 下载器")
    parser.add_argument("--out-dir", "-d", required=True,
                        help="PDF 保存目录")
    parser.add_argument("--max", type=int, default=10,
                        help="最多下载数量，默认 10")
    args = parser.parse_args()
    try:
        records = run(args.input, args.out_dir, max_download=args.max,
                       task_id=args.task_id)
        write_output(make_ok(records), args.out)
        log_stderr(f"pdf_downloader: 共下载 {len(records)} 个 PDF")
    except Exception as e:
        emit_error(f"PDF 下载失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
