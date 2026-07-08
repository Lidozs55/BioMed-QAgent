"""Parser Agent — 文献与生物数据解析 + 爬虫原始内容 LLM 提取 + 图表数据提取。

从 Orchestrator._stage_parse 迁入，职责：
- 解析用户上传的 PDF（表格 + caption）
- 自动下载搜索结果中的开放获取 PDF 并解析
- 对 acquire 阶段产出的 raw crawl record 调用 LLMExtractor 提取结构化字段
- 对用户上传的图表图片调用 Qwen-VL 提取图表数据（chart_type/axes/data_points）
- 记录溯源
"""
from __future__ import annotations

import logging
from pathlib import Path

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.llm_extractor import LLMExtractor, is_raw_crawl_record
from app.agents.registry import AgentRegistry
from app.models.task import Task, StageStatus
from app.tools.parsers._base import make_record
from app.utils.paths import get_task_output_dir

logger = logging.getLogger(__name__)

# 支持的图表图片扩展名
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


@AgentRegistry.register
class ParserAgent(BaseAgent):
    name = "parse"
    description = "PDF 解析 + 爬虫原始内容 LLM 提取"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        self._set_stage(task, "parse", StageStatus.RUNNING, "检查需要解析的文件...")
        self._emit(progress, type="stage_start", stage="parse",
                    message="解析上传文件 + 爬虫内容 LLM 提取 + 开放获取论文下载...")

        out_dir = get_task_output_dir(task.task_id)
        uploads_dir = Path(task.output_dir).parent.parent / "uploads"
        parsed_records: list[dict] = []
        extracted_from_crawl: list[dict] = []

        # Step 1: 爬虫原始记录 LLM 提取（acquire 阶段产出的 raw_content）
        extracted_from_crawl = await self._extract_crawl_records(
            records, task, progress)

        # Step 2: 解析用户上传的 PDF
        if uploads_dir.exists():
            pdf_files = list(uploads_dir.glob("*.pdf"))
            for pdf in pdf_files:
                self._emit(progress, type="stage_progress", stage="parse",
                            pct=0.4, message=f"解析上传 PDF: {pdf.name}")
                out_file = out_dir / f"parsed_{pdf.stem}.json"
                result = await self._to_thread(
                    self.tools.parse_pdf_table, pdf, out_file,
                )
                if result.success and result.data:
                    parsed_records.extend(self._extract_records(result))

        # Step 3: 图表图片数据提取（Qwen-VL 多模态识别）
        chart_records = await self._extract_chart_images(
            uploads_dir, out_dir, task, progress)

        # Step 4: 自动下载搜索结果中的开放获取 PDF
        def _has_pdf(r: dict) -> bool:
            fields = r.get("fields", {}) or {}
            if fields.get("pdf_url"):
                return True
            oa = fields.get("best_oa_location")
            return isinstance(oa, dict) and bool(oa.get("pdf_url"))

        pdf_candidates = [r for r in records if _has_pdf(r)][:5]

        if pdf_candidates:
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.6,
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
                        pct=0.8, message=f"下载完成：{len(downloaded)} 篇 PDF")

            # Step 5: 对下载的 PDF 调用 pdf_table_parser 提取表格+caption
            if pdf_dir.exists():
                for pdf_file in sorted(pdf_dir.glob("*.pdf")):
                    self._emit(progress, type="stage_progress", stage="parse",
                                pct=0.9, message=f"解析 PDF: {pdf_file.name}")
                    out_file = out_dir / f"parsed_{pdf_file.stem}.json"
                    result = await self._to_thread(
                        self.tools.parse_pdf_table, pdf_file, out_file,
                    )
                    if result.success and result.data:
                        parsed_records.extend(self._extract_records(result))

        # Step 5: 用户上传的图表图片 → Qwen-VL 提取图表数据
        chart_records = await self._extract_chart_records(
            uploads_dir, task, progress)

        # 用 LLM 提取的结构化记录替换 raw crawl record（就地更新 records）
        if extracted_from_crawl:
            self._replace_crawl_records(records, extracted_from_crawl)

        # 记录溯源：parse 阶段
        prov = self.store.get_provenance(task.task_id)
        if prov and (parsed_records or extracted_from_crawl or chart_records):
            new_recs = parsed_records + extracted_from_crawl + chart_records
            rec_ids = [r.get("record_id", "") for r in new_recs]
            prov.record("parse", "parse_agent",
                       tool_name="pdf_table+pdf_download+llm_extract+chart_vision",
                       output_records=rec_ids,
                       parameters={"pdf_parsed": len(parsed_records),
                                   "crawl_extracted": len(extracted_from_crawl),
                                   "chart_extracted": len(chart_records),
                                   "downloaded_count": len(pdf_candidates)})

        msg = (f"解析完成：PDF {len(parsed_records)} 条 + "
               f"爬虫 LLM 提取 {len(extracted_from_crawl)} 条 + "
               f"图表提取 {len(chart_records)} 条")
        records.extend(parsed_records)
        records.extend(chart_records)
        self._set_stage(task, "parse", StageStatus.DONE, msg,
                        records_count=len(records))
        self._emit(progress, type="stage_complete", stage="parse", message=msg)
        self.store.update_task(task)
        return records, context

    async def _extract_crawl_records(self, records: list[dict], task: Task,
                                      progress: ProgressCallback | None) -> list[dict]:
        """对 raw crawl record 调用 LLMExtractor 提取结构化字段。

        Returns:
            LLM 提取出的 DataRecord 列表（将替换 raw crawl record）
        """
        raw_records = [r for r in records if is_raw_crawl_record(r)]
        if not raw_records:
            return []

        self._emit(progress, type="stage_progress", stage="parse",
                    pct=0.15,
                    message=f"LLM 提取 {len(raw_records)} 条爬虫原始记录...")

        extractor = LLMExtractor(self.llm)
        extracted: list[dict] = []
        for idx, raw in enumerate(raw_records):
            source = raw.get("crawl_source", "web_crawler")
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.15 + 0.2 * (idx + 1) / len(raw_records),
                        message=f"LLM 提取 {source} ({idx+1}/{len(raw_records)})")
            try:
                recs = await self._to_thread(extractor.extract, raw)
                extracted.extend(recs)
            except Exception as e:
                logger.warning("LLM 提取 %s 失败（已跳过）: %s", source, e)
                task.errors.append(f"llm_extract {source}: {e}")

        self._emit(progress, type="stage_progress", stage="parse",
                    pct=0.35,
                    message=f"✓ LLM 提取完成：{len(extracted)} 条结构化记录")
        return extracted

    async def _extract_chart_records(self, uploads_dir: Path, task: Task,
                                      progress: ProgressCallback | None) -> list[dict]:
        """对用户上传的图表图片调用 Qwen-VL 提取图表数据。

        扫描 uploads_dir 中的图片文件（png/jpg/jpeg/webp/bmp/gif），
        调用 ToolRegistry.extract_chart_data（底层 Qwen-VL API）提取
        chart_type/axes/data_points/legend，构造 DataRecord。

        Returns:
            图表数据记录列表（entity_type="Chart"）
        """
        if not uploads_dir.exists():
            return []

        image_files = [f for f in sorted(uploads_dir.iterdir())
                       if f.suffix.lower() in _IMAGE_EXTS and f.is_file()]
        if not image_files:
            return []

        self._emit(progress, type="stage_progress", stage="parse",
                    pct=0.55,
                    message=f"Qwen-VL 提取 {len(image_files)} 张图表...")

        out_dir = get_task_output_dir(task.task_id)
        chart_records: list[dict] = []
        for idx, img in enumerate(image_files):
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.55 + 0.1 * (idx + 1) / len(image_files),
                        message=f"图表提取 {img.name} ({idx+1}/{len(image_files)})")
            try:
                out_file = out_dir / f"chart_{img.stem}.json"
                result = await self._to_thread(
                    self.tools.extract_chart_data, img, out_file,
                )
                if result.success and result.data:
                    fields = {
                        "entity_type": "Chart",
                        "chart_type": result.data.get("chart_type", "unknown"),
                        "axes": result.data.get("axes"),
                        "data_points": result.data.get("data_points", []),
                        "legend": result.data.get("legend", []),
                        "image_file": img.name,
                    }
                    rec = make_record(
                        task_id=task.task_id, source_name="qwen_vl",
                        fields=fields, file_path=str(img),
                        confidence=0.75, method="chart",
                        accession=f"chart_{img.stem}",
                        source_type="file")
                    chart_records.append(rec)
            except Exception as e:
                logger.warning("图表提取 %s 失败（已跳过）: %s", img.name, e)
                task.errors.append(f"chart_extract {img.name}: {e}")

        if chart_records:
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.65,
                        message=f"✓ 图表提取完成：{len(chart_records)} 条")
        return chart_records

    @staticmethod
    def _replace_crawl_records(records: list[dict],
                                extracted: list[dict]) -> None:
        """用 LLM 提取的结构化记录替换 records 中的 raw crawl record（就地）。

        保留 records 中已有的 DataRecord（API/search 阶段产出），
        移除 raw crawl record，追加提取出的 DataRecord。
        """
        # 过滤掉 raw crawl record，保留已结构化的 DataRecord
        kept = [r for r in records if not is_raw_crawl_record(r)]
        records.clear()
        records.extend(kept)
        records.extend(extracted)
