"""Parser Agent — 文献与生物数据解析。

从 Orchestrator._stage_parse 迁入，职责：
- 解析用户上传的 PDF（表格 + caption）
- 自动下载搜索结果中的开放获取 PDF 并解析
- 记录溯源
"""
from __future__ import annotations

import logging
from pathlib import Path

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.registry import AgentRegistry
from app.models.task import Task, StageStatus
from app.utils.paths import get_task_output_dir

logger = logging.getLogger(__name__)


@AgentRegistry.register
class ParserAgent(BaseAgent):
    name = "parse"
    description = "PDF 表格解析 + 开放获取论文下载"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        self._set_stage(task, "parse", StageStatus.RUNNING, "检查需要解析的文件...")
        self._emit(progress, type="stage_start", stage="parse",
                    message="解析上传文件 + 自动下载开放获取论文 PDF...")

        out_dir = get_task_output_dir(task.task_id)
        uploads_dir = Path(task.output_dir).parent.parent / "uploads"
        parsed_records: list[dict] = []

        # Step 1: 解析用户上传的 PDF
        if uploads_dir.exists():
            pdf_files = list(uploads_dir.glob("*.pdf"))
            for pdf in pdf_files:
                self._emit(progress, type="stage_progress", stage="parse",
                            pct=0.2, message=f"解析上传 PDF: {pdf.name}")
                out_file = out_dir / f"parsed_{pdf.stem}.json"
                result = await self._to_thread(
                    self.tools.parse_pdf_table, pdf, out_file,
                )
                if result.success and result.data:
                    parsed_records.extend(self._extract_records(result))

        # Step 2: 自动下载搜索结果中的开放获取 PDF
        def _has_pdf(r: dict) -> bool:
            fields = r.get("fields", {}) or {}
            if fields.get("pdf_url"):
                return True
            oa = fields.get("best_oa_location")
            return isinstance(oa, dict) and bool(oa.get("pdf_url"))

        pdf_candidates = [r for r in records if _has_pdf(r)][:5]

        if pdf_candidates:
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.4,
                        message=f"尝试下载 {len(pdf_candidates)} 篇开放获取论文...")
            pdf_dir = out_dir / "pdfs"
            dl_out = out_dir / "downloaded_records.json"
            result = await self._to_thread(
                self.tools.download_pdfs, records, pdf_dir,
                5, task.task_id, dl_out,
            )
            downloaded = []
            if result.success:
                downloaded = self._extract_records(result)
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.7, message=f"下载完成：{len(downloaded)} 篇 PDF")

            # Step 3: 对下载的 PDF 调用 pdf_table_parser 提取表格+caption
            if pdf_dir.exists():
                for pdf_file in sorted(pdf_dir.glob("*.pdf")):
                    self._emit(progress, type="stage_progress", stage="parse",
                                pct=0.85, message=f"解析 PDF: {pdf_file.name}")
                    out_file = out_dir / f"parsed_{pdf_file.stem}.json"
                    result = await self._to_thread(
                        self.tools.parse_pdf_table, pdf_file, out_file,
                    )
                    if result.success and result.data:
                        parsed_records.extend(self._extract_records(result))

        # 记录溯源：parse 阶段
        prov = self.store.get_provenance(task.task_id)
        if prov and parsed_records:
            rec_ids = [r.get("record_id", "") for r in parsed_records]
            prov.record("parse", "parse_agent",
                       tool_name="pdf_table+pdf_download",
                       output_records=rec_ids,
                       parameters={"uploaded_count": len(parsed_records),
                                   "downloaded_count": len(pdf_candidates)})

        msg = f"解析完成：{len(parsed_records)} 条新记录（含上传 PDF + 自动下载 PDF）"
        records.extend(parsed_records)
        self._set_stage(task, "parse", StageStatus.DONE, msg,
                        records_count=len(records))
        self._emit(progress, type="stage_complete", stage="parse", message=msg)
        self.store.update_task(task)
        return records, context
