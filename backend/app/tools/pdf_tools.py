"""PDF 提取工具 — 供附件解析 Agent 调用。

D3 决策：使用 ``pdfplumber`` 库提取 PDF 文本和表格。工具不在沙箱内，
因为 PDF 解析涉及复杂 I/O 和二进制处理，不符合沙箱的纯计算语义。

LLM 编排（含进度提示）：
  1. 先调 ``extract_pdf(input_relative_path, start_page=1, end_page=2)``
     探查文档结构与总页数
  2. 向用户输出进度消息（如"正在解析 xxx.pdf（2/50 页）..."）
  3. 按 chunk（建议 10 页）循环调用 ``extract_pdf`` 提取剩余内容，
     每 chunk 之间输出进度消息
  4. 决定分段策略（按章节/按页/按表格）
  5. 生成 22 列行（``measurement_type=paper_*``）
  6. 调 ``commit_to_cache`` 写入缓存

注意：``extract_pdf`` 不设 max_pages 上限（用户可能上传长论文），
但 LLM 必须使用 ``start_page``/``end_page`` 分块调用，避免一次性
返回过长的 JSON 触发 LLM 上下文上限，同时让前端能展示解析进度。
"""

from __future__ import annotations

import logging
from typing import Any

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext

logger = logging.getLogger(__name__)


@function_tool(
    name_override="extract_pdf",
    description_override=(
        "Extract text and tables from a PDF file with optional page range. "
        "Returns pages with text content and extracted tables. Use for PDF "
        "papers/reports/database dumps. The tool reads the PDF from the task "
        "workdir. No max page limit — but ALWAYS extract in chunks "
        "(start_page/end_page, e.g. 10 pages per call) for large PDFs, so "
        "the user sees progress messages between chunks and the response "
        "stays within LLM context limits."
    ),
)
def extract_pdf(
    ctx: RunContextWrapper[Any],
    input_relative_path: str,
    start_page: int = 1,
    end_page: int = 0,
) -> str:
    """Extract text and tables from a PDF file in the task workdir.

    Args:
        input_relative_path: Relative path under the task workdir
            (e.g. ``source_assets/paper.pdf``).
        start_page: 1-based start page (inclusive). Defaults to 1.
            Use 1 for the first exploration call.
        end_page: 1-based end page (inclusive). 0 or negative means
            "until end of document". For chunked extraction, set this to
            ``start_page + chunk_size - 1`` (e.g. ``start_page=11,
            end_page=20``).

    Returns:
        JSON string with structure::
            {
              "pages": [
                {
                  "page_number": 1,
                  "text": "...",
                  "tables": [[{"col1": "val1", ...}, ...], ...]
                },
                ...
              ],
              "total_pages": N,        # 文档总页数（始终为全文总页数）
              "extracted_pages": M,    # 本次实际返回的页数
              "range": [start, end]    # 本次返回的页码范围
            }
    """
    import json

    run_ctx: RunContext = ctx.context
    task_root = run_ctx.work_dir.root.resolve()
    pdf_path = (task_root / input_relative_path).resolve()
    try:
        pdf_path.relative_to(task_root)
    except ValueError as exc:
        return f"路径错误: {exc}（必须在任务目录内）"

    if not pdf_path.is_file():
        return f"PDF 文件不存在: {input_relative_path}"

    try:
        import pdfplumber
    except ImportError:
        return (
            "pdfplumber 未安装。请在 backend 目录运行 "
            "`uv add pdfplumber` 安装 PDF 解析依赖。"
        )

    if start_page < 1:
        start_page = 1

    pages_result: list[dict[str, Any]] = []
    total_pages = 0
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            total_pages = len(pdf.pages)
            # 计算 1-based 闭区间 [start_idx, end_idx]
            start_idx = max(1, start_page)
            end_idx = (
                min(end_page, total_pages)
                if end_page and end_page > 0
                else total_pages
            )
            for i in range(start_idx, end_idx + 1):
                page = pdf.pages[i - 1]
                text = page.extract_text() or ""
                tables = page.extract_tables() or []
                # 把表格转为 list[list[dict]]（每行是 dict，key 是表头）
                table_dicts: list[list[dict[str, str]]] = []
                for table in tables:
                    if not table or len(table) < 2:
                        continue
                    header = [str(cell or "").strip() for cell in table[0]]
                    for row in table[1:]:
                        row_dict = {}
                        for col_idx, cell in enumerate(row):
                            if col_idx < len(header):
                                row_dict[header[col_idx]] = str(cell or "").strip()
                        if any(row_dict.values()):
                            table_dicts.append(row_dict)
                pages_result.append(
                    {
                        "page_number": i,
                        "text": text,
                        "tables": table_dicts,
                    }
                )
    except Exception as exc:  # noqa: BLE001 — PDF 解析错误需返回给 LLM
        return f"PDF 解析失败: {exc}"

    result = {
        "pages": pages_result,
        "total_pages": total_pages,
        "extracted_pages": len(pages_result),
        "range": [start_page, end_page if end_page > 0 else total_pages],
    }
    return json.dumps(result, ensure_ascii=False)
