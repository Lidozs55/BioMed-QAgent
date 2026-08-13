"""PDF table and metadata extraction skill for BioMed research papers.

Provides function_tools that extract structured tables and metadata from
PDF files downloaded to task/raw/. Uses pdfplumber when available, PyPDF2
as second choice, otherwise falls back to regex-based extraction from raw
PDF content streams with a warning about limited accuracy.

Tools:
    extract_pdf_tables   — extract all tables, save each as CSV to task/parsed/
    extract_pdf_metadata — extract title, authors, DOI, abstract, captions, page count
"""

from __future__ import annotations

import csv
import json
import logging
import re
import unicodedata
import zlib
from pathlib import Path
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.skills.categories import SkillCategory
from app.tools.workdir import resolve_task_local_file

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# lazy PDF-backend resolution (tried once, cached)
# ---------------------------------------------------------------------------

_pdf_backend: tuple[str | None, Any] | None = None


def _resolve_pdf_backend() -> tuple[str | None, Any]:
    """Return (backend_name, module_or_None).  Cached after first call."""
    global _pdf_backend
    if _pdf_backend is not None:
        return _pdf_backend

    for name in ("pdfplumber", "PyPDF2"):
        try:
            mod = __import__(name)
            _pdf_backend = (name, mod)
            logger.info("PDF backend: %s", name)
            return _pdf_backend
        except ImportError:
            continue

    _pdf_backend = (None, None)
    logger.warning("No PDF library available — using regex fallback (limited accuracy)")
    return _pdf_backend


# ---------------------------------------------------------------------------
# raw-fallback helpers
# ---------------------------------------------------------------------------

_PDF_TEXT_RE = re.compile(
    r"BT\s*(.*?)\s*ET", re.DOTALL
)
# A PDF string operand: literal ``(...)`` or hex ``<...>``.  Hex strings are
# how CJK-aware producers emit non-ASCII text (usually UTF-16BE).
_PDF_STRING_PART = r"(?:\(([^)]*(?:\\.[^)]*)*)\)|<([0-9a-fA-F\s]+)>)"
_PDF_STRING_RE = re.compile(_PDF_STRING_PART)
_PDF_TJ_CALL_RE = re.compile(_PDF_STRING_PART + r"\s*Tj")
_PDF_ARRAY_RE = re.compile(
    r"\[(.*?)\]\s*TJ", re.DOTALL
)
_PDF_STRIP_ESCAPES = re.compile(r"\\([()\\nrtbf])")
_PDF_DOI_RE = re.compile(r"(10\.\d{4,}/[^\s]+)")
_PDF_CAPTION_RE = re.compile(
    r"^(Fig(?:ure)?|Table)\s*\d+[\.:]\s*(.*)", re.IGNORECASE | re.MULTILINE
)
_PDF_PAGE_RE = re.compile(r"/Type\s*/Page[^s]")
_PDF_STREAM_RE = re.compile(
    rb"(?:<<[^>]*>>\s*)?stream\r?\n(.*?)\r?\nendstream", re.DOTALL
)
_PDF_FILTER_RE = re.compile(rb"/Filter\s*/FlateDecode")
_TABLE_SEP_RE = re.compile(r"\s{3,}|\t")
_HEADING_RE = re.compile(
    r"^(?:Abstract|ABSTRACT|A B S T R A C T)\s*$", re.MULTILINE
)


def _decompress_pdf_streams(raw: bytes) -> bytes:
    """Attempt to decompress FlateDecode streams in PDF raw bytes."""
    result = raw
    for match in _PDF_STREAM_RE.finditer(raw):
        stream_block = match.group(0)
        # check if this stream might be compressed
        if b"/Filter" in stream_block and b"FlateDecode" in stream_block:
            inner = match.group(1)
            try:
                decompressed = zlib.decompress(inner)
                result = result.replace(inner, decompressed)
            except zlib.error:
                pass
    return result


def _recover_utf8_literal(text: str) -> str:
    """Recover a UTF-8 literal (e.g. CJK) from latin-1-decoded PDF content.

    ``_extract_text_via_regex`` decodes the raw bytes as latin-1 to preserve
    PDF operator bytes, which turns UTF-8 CJK literals into mojibake.  Re-encode
    to bytes and retry as UTF-8; if that fails the text is genuine latin-1 and
    is returned unchanged (ASCII is untouched).
    """
    if text.isascii():
        return text
    try:
        raw = text.encode("latin-1")
    except UnicodeEncodeError:
        return text
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return text


def _looks_like_utf16be_cjk(data: bytes) -> bool:
    """Heuristic: at least half the 16-bit pairs fall in CJK Unified Ideographs
    (U+4E00..U+9FFF), i.e. the string is likely UTF-16BE CJK without a BOM."""
    if len(data) < 2 or len(data) % 2:
        return False
    pairs = [int.from_bytes(data[i:i + 2], "big") for i in range(0, len(data), 2)]
    cjk = sum(1 for cp in pairs if 0x4E00 <= cp <= 0x9FFF)
    return cjk >= len(pairs) // 2


def _decode_pdf_bytes(data: bytes) -> str:
    """Decode raw bytes of a PDF hex string to text.

    CJK-aware producers emit UTF-16BE (usually BOM-prefixed); ASCII producers
    emit single-byte (latin-1) text.  Heuristic order:
      1. UTF-16 BOM present -> decode as UTF-16 (BOM-aware).
      2. Interleaved NUL bytes -> UTF-16BE.
      3. Valid UTF-8 -> UTF-8.
      4. Mostly CJK code points -> UTF-16BE (no BOM).
      5. Otherwise -> latin-1.
    """
    if not data:
        return ""
    if data[:2] in (b"\xfe\xff", b"\xff\xfe"):
        return data.decode("utf-16")
    if data.count(0x00) and data.count(0x00) >= len(data) // 2:
        try:
            return data.decode("utf-16-be")
        except UnicodeDecodeError:
            pass
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    if _looks_like_utf16be_cjk(data):
        return data.decode("utf-16-be")
    return data.decode("latin-1")


def _decode_hex_string(hex_content: str) -> str:
    """Decode a PDF ``<...>`` hex string (whitespace ignored) to text."""
    compact = re.sub(r"\s+", "", hex_content)
    if len(compact) % 2:
        compact += "0"
    try:
        data = bytes.fromhex(compact)
    except ValueError:
        return ""
    return _decode_pdf_bytes(data)


def _decode_pdf_string(literal: str | None, hex_content: str | None) -> str:
    """Decode one PDF string operand: a literal ``(...)`` or a hex ``<...>``."""
    if literal is not None:
        text = _PDF_STRIP_ESCAPES.sub(r"\1", literal)
        return _recover_utf8_literal(text)
    return _decode_hex_string(hex_content or "")


def _extract_text_via_regex(file_path: str) -> str:
    """Extract plain text from a PDF using regex on raw content streams.

    Handles:
    - Decompressed content streams (FlateDecode)
    - BT/ET text blocks
    - Tj (single string) and TJ (array of strings) operators
    - Literal ``(...)`` strings and hex ``<...>`` strings (UTF-16BE CJK
      hex strings are decoded; UTF-8 CJK literals are recovered)
    - Basic escape-sequence cleanup

    Returns extracted text, one line per text-showing operation.
    """
    raw = Path(file_path).read_bytes()
    raw = _decompress_pdf_streams(raw)

    # Decode as latin-1 to preserve byte values in PDF operators
    try:
        content = raw.decode("latin-1", errors="replace")
    except UnicodeDecodeError:
        content = raw.decode("utf-8", errors="replace")

    lines: list[str] = []

    for block_match in _PDF_TEXT_RE.finditer(content):
        block = block_match.group(1)

        # Single Tj calls
        for tj in _PDF_TJ_CALL_RE.finditer(block):
            text = _decode_pdf_string(tj.group(1), tj.group(2))
            text = text.strip()
            if text:
                lines.append(text)

        # TJ array calls
        for tj_arr in _PDF_ARRAY_RE.finditer(block):
            inner = tj_arr.group(1)
            # Extract literal and hex strings from the array, in order
            parts: list[str] = []
            for sm in _PDF_STRING_RE.finditer(inner):
                parts.append(_decode_pdf_string(sm.group(1), sm.group(2)))
            line = "".join(parts).strip()
            if line:
                lines.append(line)

    return "\n".join(lines)


def _detect_delimited_rows(text: str) -> list[list[str]]:
    """Heuristic: detect rows that look tabular (consistent multi-column layout)."""
    text_lines = text.split("\n")
    rows: list[list[str]] = []

    for line in text_lines:
        stripped = line.strip()
        if not stripped:
            continue
        # Skip short single-word lines (unlikely to be table rows)
        cells = _TABLE_SEP_RE.split(stripped)
        if len(cells) >= 2:
            rows.append([c.strip() for c in cells])

    if not rows:
        return []

    # Filter: keep rows with consistent-ish column counts
    col_counts = [len(r) for r in rows]
    if len(col_counts) >= 3:
        # Use the mode as expected columns
        from collections import Counter
        mode_count = Counter(col_counts).most_common(1)[0][0]
        rows = [
            r for r in rows
            if len(r) == mode_count
            or (mode_count - 1 <= len(r) <= mode_count + 1)
        ]

    return rows


def _clean_header(header: str) -> str:
    """Clean a column name."""
    h = header.strip()
    # Normalize unicode
    h = unicodedata.normalize("NFKC", h)
    # Replace newlines/tabs with spaces
    h = re.sub(r"[\n\r\t]+", " ", h)
    # Collapse multiple spaces
    h = re.sub(r"\s{2,}", " ", h)
    # Remove non-printable
    h = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", h)
    # Trim to reasonable length
    if len(h) > 100:
        h = h[:100]
    if not h:
        h = "column"
    return h


def _extract_raw_tables(
    file_path: str,
) -> tuple[list[dict[str, Any]], str]:
    """Extract tables using the best available backend.

    Returns (table_list, warning_string).  Each table dict:
        {"rows": [[cell, ...], ...], "page": int|None, "header": [col, ...]|None}
    """
    backend_name, backend = _resolve_pdf_backend()
    warning = ""

    if backend_name == "pdfplumber":
        return _extract_via_pdfplumber(backend, file_path)

    if backend_name == "PyPDF2":
        return _extract_via_pypdf2(backend, file_path)

    # ── fallback ──────────────────────────────────────────────────────
    warning = (
        "pdfplumber 和 PyPDF2 均未安装；使用正则从 PDF 原始流提取文本，"
        "表格检测精度有限。建议安装 pdfplumber 以获取更准确的表格提取结果。"
    )
    logger.warning("Falling back to regex extraction for %s", file_path)

    text = _extract_text_via_regex(file_path)
    rows = _detect_delimited_rows(text)

    if not rows:
        logger.info("No tabular rows detected via regex in %s", file_path)
        return [], warning

    # Use first row as header, rest as data
    header = [_clean_header(h) for h in rows[0]]
    data = rows[1:]

    # Pad/normalize row lengths
    for i, row in enumerate(data):
        while len(row) < len(header):
            row.append("")
        data[i] = row[:len(header)]

    return [{
        "rows": data,
        "page": None,
        "header": header,
    }], warning


def _extract_via_pdfplumber(plumber: Any, file_path: str) -> tuple[list[dict], str]:
    """Extract tables via pdfplumber.

    Detects image-only (scanned) PDFs — no text layer, no tables, but image
    objects present — and returns a warning pointing the Agent at the Qwen-VL
    ``extract_chart_data_vlm`` channel.  OCR (pytesseract) is intentionally
    not part of the stack (see pyproject.toml / TODO §5.2).
    """
    tables: list[dict] = []
    total_text_len = 0
    has_images = False
    with plumber.open(file_path) as pdf:
        for page_num, page in enumerate(pdf.pages, 1):
            total_text_len += len((page.extract_text() or "").strip())
            if page.images:
                has_images = True
            page_tables = page.extract_tables()
            for tbl in page_tables:
                if not tbl:
                    continue
                # first row as header
                header_raw = tbl[0] if tbl else []
                header = [_clean_header(str(c) if c is not None else f"col_{i}")
                          for i, c in enumerate(header_raw)]
                data = tbl[1:]
                # clean and pad
                clean_data: list[list[str]] = []
                for row in data:
                    clean_row = [str(c).strip() if c is not None else "" for c in row]
                    while len(clean_row) < len(header):
                        clean_row.append("")
                    clean_data.append(clean_row[:len(header)])
                tables.append({
                    "rows": clean_data,
                    "page": page_num,
                    "header": header,
                })
    warning = ""
    if not tables and total_text_len == 0 and has_images:
        warning = (
            "该 PDF 未检测到文本层但包含页面图像（疑似扫描件或图片型 PDF），"
            "pdfplumber 无法提取文本表格。本项目不依赖 OCR（pytesseract 已被"
            "移除，见 TODO §5.2）；请改用 extract_chart_data_vlm 技能（Qwen-VL "
            "视觉模型）从该 PDF/页面图像中提取图表数据。"
        )
        logger.warning("Scanned/image-only PDF detected (no text layer): %s", file_path)
    return tables, warning


def _extract_via_pypdf2(pypdf2: Any, file_path: str) -> tuple[list[dict], str]:
    """Extract tables via PyPDF2 (basic – text only, heuristic table detection)."""
    tables: list[dict] = []
    reader = pypdf2.PdfReader(file_path)
    for page_num, page in enumerate(reader.pages, 1):
        text = page.extract_text() or ""
        rows = _detect_delimited_rows(text)
        if not rows:
            continue
        header = [_clean_header(h) for h in rows[0]]
        data = rows[1:]
        for i, row in enumerate(data):
            while len(row) < len(header):
                row.append("")
            data[i] = row[:len(header)]
        tables.append({
            "rows": data,
            "page": page_num,
            "header": header,
        })
    return tables, ""


def _extract_text_for_metadata(file_path: str) -> tuple[str, int]:
    """Extract full text and page count for metadata extraction.

    Returns (full_text, page_count).
    """
    backend_name, backend = _resolve_pdf_backend()

    if backend_name == "pdfplumber":
        with backend.open(file_path) as pdf:
            pages = [p.extract_text() or "" for p in pdf.pages]
            return "\n\n".join(pages), len(pdf.pages)

    if backend_name == "PyPDF2":
        reader = backend.PdfReader(file_path)
        pages = [(p.extract_text() or "") for p in reader.pages]
        return "\n\n".join(pages), len(reader.pages)

    # fallback: regex + count /Page objects
    text = _extract_text_via_regex(file_path)
    raw = Path(file_path).read_bytes().decode("latin-1", errors="replace")
    page_count = len(_PDF_PAGE_RE.findall(raw))
    if page_count == 0:
        page_count = 1  # at least 1
    return text, page_count


# ---------------------------------------------------------------------------
# Function Tools
# ---------------------------------------------------------------------------


@function_tool
def extract_pdf_tables(
    ctx: RunContextWrapper[Any],
    file_path: str,
) -> str:
    """Extract all tables from a PDF and save each as CSV to task/parsed/.

    Uses pdfplumber if available; falls back to PyPDF2, then regex-based
    extraction.  Each table is saved as ``{pdf_stem}_table_{N}.csv``.

    Args:
        file_path: Path to the PDF file under task/raw/.

    Returns:
        JSON string with status, source_file, outputs (list of saved CSV
        paths), summary (total tables, page numbers, column counts), and
        an optional warning when running without a real PDF library.
    """
    run_ctx: RunContext = ctx.context
    try:
        path = resolve_task_local_file(run_ctx.work_dir, file_path)
    except FileNotFoundError:
        return json.dumps({
            "status": "error",
            "error": f"文件不存在: {file_path}",
            "source_file": file_path,
        }, ensure_ascii=False)
    except ValueError as exc:
        return json.dumps({
            "status": "error",
            "error": str(exc),
            "source_file": file_path,
        }, ensure_ascii=False)

    if not path.suffix.lower().endswith("pdf"):
        return json.dumps({
            "status": "error",
            "error": f"不支持的文件类型: {path.suffix}（需要 .pdf）",
            "source_file": file_path,
        }, ensure_ascii=False)

    try:
        tables, warning = _extract_raw_tables(str(path))
    except Exception as exc:
        logger.exception("Failed to extract tables from %s", file_path)
        return json.dumps({
            "status": "error",
            "error": f"表格提取失败: {exc}",
            "source_file": file_path,
        }, ensure_ascii=False)

    # ── no tables found ───────────────────────────────────────────────
    if not tables:
        resp: dict[str, Any] = {
            "status": "ok",
            "source_file": str(path.name),
            "outputs": [],
            "summary": {
                "total_tables": 0,
                "tables": [],
            },
        }
        if warning:
            resp["warning"] = warning
        return json.dumps(resp, ensure_ascii=False)

    # ── save each table as CSV ────────────────────────────────────────
    parsed_dir = run_ctx.work_dir.parsed
    parsed_dir.mkdir(parents=True, exist_ok=True)

    stem = path.stem
    saved_paths: list[str] = []
    table_meta: list[dict[str, Any]] = []
    failed_count = 0

    for idx, table in enumerate(tables, 1):
        csv_name = f"{stem}_table_{idx}.csv"
        csv_path = parsed_dir / csv_name
        header = table.get("header") or [
            f"col_{j}" for j
            in range(len(table["rows"][0]) if table["rows"] else 1)
        ]
        rows = table.get("rows", [])

        # Sanitize: ensure all row lengths match header
        sanitized: list[list[str]] = []
        for row in rows:
            r = [str(c).strip() for c in row]
            while len(r) < len(header):
                r.append("")
            sanitized.append(r[:len(header)])

        try:
            with open(str(csv_path), "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.writer(f)
                writer.writerow(header)
                writer.writerows(sanitized)
        except Exception as exc:
            logger.warning("Failed to write CSV %s: %s", csv_path, exc)
            failed_count += 1
            continue

        saved_paths.append(str(csv_path))
        table_meta.append({
            "table_index": idx,
            "page": table.get("page"),
            "row_count": len(sanitized),
            "column_count": len(header),
            "column_names": header,
            "saved_path": str(csv_path),
        })

    # Register in context
    for sp in saved_paths:
        run_ctx.parsed_datasets.append(sp)

    resp = {
        "status": "ok",
        "source_file": str(path.name),
        "outputs": saved_paths,
        "summary": {
            "total_tables": len(tables),
            "tables": table_meta,
            "failed_count": failed_count,
        },
    }
    if warning:
        resp["warning"] = warning

    return json.dumps(resp, ensure_ascii=False)


@function_tool
def extract_pdf_metadata(
    ctx: RunContextWrapper[Any],
    file_path: str,
) -> str:
    """Extract paper metadata from a PDF and save as JSON to task/parsed/.

    Extracts: title, authors (heuristic), DOI, abstract (first body
    paragraph after "Abstract" heading), figure/table captions, and
    page count.

    Saves metadata to ``{pdf_stem}_metadata.json``.

    Args:
        file_path: Path to the PDF file under task/raw/.

    Returns:
        JSON string with status, source_file, outputs, and summary
        containing all extracted metadata fields.
    """
    run_ctx: RunContext = ctx.context
    try:
        path = resolve_task_local_file(run_ctx.work_dir, file_path)
    except FileNotFoundError:
        return json.dumps({
            "status": "error",
            "error": f"文件不存在: {file_path}",
            "source_file": file_path,
        }, ensure_ascii=False)
    except ValueError as exc:
        return json.dumps({
            "status": "error",
            "error": str(exc),
            "source_file": file_path,
        }, ensure_ascii=False)

    if not path.suffix.lower().endswith("pdf"):
        return json.dumps({
            "status": "error",
            "error": f"不支持的文件类型: {path.suffix}（需要 .pdf）",
            "source_file": file_path,
        }, ensure_ascii=False)

    try:
        full_text, page_count = _extract_text_for_metadata(str(path))
    except Exception as exc:
        logger.exception("Failed to extract text from %s", file_path)
        return json.dumps({
            "status": "error",
            "error": f"文本提取失败: {exc}",
            "source_file": file_path,
        }, ensure_ascii=False)

    lines = full_text.split("\n")
    text_single = full_text.replace("\n", " ")

    # ── title ─────────────────────────────────────────────────────────
    # Heuristic: first non-empty, non-whitespace-only line that is > 1 word
    title = ""
    for line in lines:
        stripped = line.strip()
        if stripped and len(stripped.split()) > 1:
            title = stripped
            break

    # ── authors ───────────────────────────────────────────────────────
    # Heuristic: line after title, or look for common author-list patterns
    authors = ""
    author_lines: list[str] = []
    for line in lines[1:15]:  # first 15 lines typically contain authors
        stripped = line.strip()
        if not stripped or len(stripped) > 200:
            continue
        # If line contains multiple capitalized names with commas
        if re.search(r"[A-Z][a-z]+,\s*[A-Z]", stripped) or \
           re.search(r"([A-Z][a-z]+)\s{2,}([A-Z][a-z]+)", stripped):
            author_lines.append(stripped)
    if author_lines:
        authors = "; ".join(author_lines)

    # ── DOI ───────────────────────────────────────────────────────────
    doi = ""
    doi_match = _PDF_DOI_RE.search(text_single)
    if doi_match:
        doi = doi_match.group(1).rstrip(".,;:")
        # Clean trailing punctuation
        doi = doi.rstrip(".,;:)")

    # ── abstract ──────────────────────────────────────────────────────
    abstract = ""
    # Find "Abstract" heading, take next substantial paragraph
    abs_match = _HEADING_RE.search(full_text)
    if abs_match:
        after_abstract = full_text[abs_match.end():]
        # Take everything until next heading-like line or double newline
        para_lines: list[str] = []
        for aline in after_abstract.split("\n"):
            stripped = aline.strip()
            if not stripped:
                if para_lines:
                    break
                continue
            # Stop at next heading (all caps, short line)
            if re.match(r"^[A-Z][A-Z\s]{4,}$", stripped) and len(stripped) < 60:
                break
            para_lines.append(stripped)
            if len(" ".join(para_lines)) > 2000:
                break
        abstract = " ".join(para_lines).strip()
    if not abstract:
        # Fallback: first substantial paragraph after title block
        for i, line in enumerate(lines):
            if i < 5:  # skip title/authors lines
                continue
            stripped = line.strip()
            if stripped and len(stripped) > 50:
                abstract = stripped
                break

    # ── captions ──────────────────────────────────────────────────────
    captions: list[str] = []
    for match in _PDF_CAPTION_RE.finditer(full_text):
        caption_text = match.group(2).strip()
        if caption_text:
            captions.append(caption_text)
        else:
            # Caption body lives on a later line; keep the label as a fallback.
            captions.append(match.group(0).strip())

    # ── save metadata JSON ────────────────────────────────────────────
    metadata = {
        "source_file": str(path.name),
        "title": title,
        "authors": authors,
        "doi": doi,
        "abstract": abstract,
        "captions": captions,
        "num_pages": page_count,
    }

    parsed_dir = run_ctx.work_dir.parsed
    parsed_dir.mkdir(parents=True, exist_ok=True)

    stem = path.stem
    meta_path = parsed_dir / f"{stem}_metadata.json"
    try:
        meta_path.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        return json.dumps({
            "status": "error",
            "error": f"写入元数据 JSON 失败: {exc}",
            "source_file": str(path.name),
        }, ensure_ascii=False)

    run_ctx.parsed_datasets.append(str(meta_path))

    resp = {
        "status": "ok",
        "source_file": str(path.name),
        "outputs": [str(meta_path)],
        "summary": metadata,
    }

    backend_name, _ = _resolve_pdf_backend()
    if backend_name is None:
        resp["warning"] = (
            "未安装 pdfplumber 或 PyPDF2；元数据提取基于正则匹配，"
            "标题、作者、摘要等字段可能不完整。建议安装 pdfplumber。"
        )

    return json.dumps(resp, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Skill registration
# ---------------------------------------------------------------------------

SKILL_NAME = 'pdf_extraction'
SKILL_CATEGORY = SkillCategory.PROCESSING
SKILL_DESCRIPTION = (
    'Extract tables and metadata from biomedical research PDFs. Saves CSVs and JSON metadata to'
    'task/parsed/. Uses pdfplumber when available, falls back to regex extraction.'
)
SKILL_VERSION = '0.1.0'
SUPPORTED_SOURCES = ['pdf', 'pubmed', 'pmc']
SKILL_TOOLS = [
    extract_pdf_tables,
    extract_pdf_metadata,
]
