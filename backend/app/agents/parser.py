"""Parser Agent — 文献与生物数据解析 + 爬虫原始内容 LLM 提取 + 图表数据提取。

从 Orchestrator._stage_parse 迁入，职责：
- 解析用户上传的 PDF（表格 + caption）
- 自动下载搜索结果中的开放获取 PDF 并解析
- 对 acquire 阶段产出的 raw crawl record 调用 LLMExtractor 提取结构化字段
- 对用户上传的图表图片调用 Qwen-VL 提取图表数据（chart_type/axes/data_points）
- 解析用户上传的生物数据文件（GEO SOFT / PDB / FASTA / 网络文件）
- 记录溯源
"""
from __future__ import annotations

import logging
from pathlib import Path

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.llm_extractor import LLMExtractor, is_raw_crawl_record
from app.agents.registry import AgentRegistry
from app.models.task import Task, StageStatus
from app.tools.parsers._base import detect_format, make_record
from app.utils.paths import get_task_output_dir

logger = logging.getLogger(__name__)

# 支持的图表图片扩展名
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}

# detect_format 返回值 → ToolRegistry 解析方法名
_BIO_PARSER_MAP = {
    "geo_soft": "parse_geo_soft",
    "pdb": "parse_pdb",
    "fasta": "parse_fasta",
    "network": "parse_network",
    "sif": "parse_network",
    "graphml": "parse_network",
}


@AgentRegistry.register
class ParserAgent(BaseAgent):
    name = "parse"
    description = "PDF 解析 + 爬虫 LLM 提取 + 图表 Qwen-VL 提取"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        self._set_stage(task, "parse", StageStatus.RUNNING, "检查需要解析的文件...")
        self._emit(progress, type="stage_start", stage="parse",
                    message="PDF解析 + 爬虫LLM提取 + 图表Qwen-VL提取 + 开放获取论文下载...")

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

        # Step 3: 自动下载搜索结果中的开放获取 PDF
        def _has_pdf(r: dict) -> bool:
            fields = r.get("fields", {}) or {}
            if fields.get("pdf_url"):
                return True
            oa = fields.get("best_oa_location")
            if isinstance(oa, dict) and oa.get("pdf_url"):
                return True
            # 有 PMCID 的记录可通过 Europe PMC fullTextXML 获取全文（国内可用）
            if fields.get("pmcid"):
                return True
            # 有 DOI 的记录可通过 Unpaywall 查询 OA PDF（可能网络不通，快速失败）
            if fields.get("doi"):
                return True
            return False

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

            # Step 4: 对下载的 PDF/XML 调用解析器提取表格+caption+全文
            if pdf_dir.exists():
                # 4a: PDF 文件 → pdf_table_parser
                for pdf_file in sorted(pdf_dir.glob("*.pdf")):
                    self._emit(progress, type="stage_progress", stage="parse",
                                pct=0.9, message=f"解析 PDF: {pdf_file.name}")
                    out_file = out_dir / f"parsed_{pdf_file.stem}.json"
                    result = await self._to_thread(
                        self.tools.parse_pdf_table, pdf_file, out_file,
                    )
                    if result.success and result.data:
                        parsed_records.extend(self._extract_records(result))
                # 4b: JATS XML 文件（EPMC fullTextXML）→ 解析全文为 records
                for xml_file in sorted(pdf_dir.glob("*.xml")):
                    self._emit(progress, type="stage_progress", stage="parse",
                                pct=0.92,
                                message=f"解析 JATS XML: {xml_file.name}")
                    recs = await self._to_thread(
                        _parse_jats_xml, xml_file, task.task_id,
                    )
                    if recs:
                        parsed_records.extend(recs)

        # Step 5: 用户上传的图表图片 + 浏览器爬虫截图 → Qwen-VL 提取图表数据
        chart_records = await self._extract_chart_records(
            uploads_dir, task, progress, records=records)

        # Step 6: 用户上传的生物数据文件 → GEO SOFT / PDB / FASTA / 网络文件解析
        bio_records = await self._parse_bio_data_records(
            uploads_dir, task, progress)

        # 用 LLM 提取的结构化记录替换 raw crawl record（就地更新 records）
        if extracted_from_crawl:
            self._replace_crawl_records(records, extracted_from_crawl)

        # 记录溯源：parse 阶段
        prov = self.store.get_provenance(task.task_id)
        all_new = parsed_records + extracted_from_crawl + chart_records + bio_records
        if prov and all_new:
            rec_ids = [r.get("record_id", "") for r in all_new]
            prov.record("parse", "parse_agent",
                       tool_name="pdf_table+pdf_download+llm_extract+chart_vision+bio_parser",
                       output_records=rec_ids,
                       parameters={"pdf_parsed": len(parsed_records),
                                   "crawl_extracted": len(extracted_from_crawl),
                                   "chart_extracted": len(chart_records),
                                   "bio_parsed": len(bio_records),
                                   "downloaded_count": len(pdf_candidates)})

        msg = (f"解析完成：PDF {len(parsed_records)} 条 + "
               f"爬虫 LLM 提取 {len(extracted_from_crawl)} 条 + "
               f"图表提取 {len(chart_records)} 条 + "
               f"生物数据 {len(bio_records)} 条")
        records.extend(parsed_records)
        records.extend(chart_records)
        records.extend(bio_records)
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
                                      progress: ProgressCallback | None,
                                      records: list[dict] | None = None) -> list[dict]:
        """对图表图片调用 Qwen-VL 提取图表数据。

        扫描两个来源：
        1. uploads_dir 中的用户上传图片（png/jpg/jpeg/webp/bmp/gif）
        2. records 中 raw_type=screenshot 的浏览器爬虫截图（TASK-012）

        调用 ToolRegistry.extract_chart_data（底层 Qwen-VL API）提取
        chart_type/axes/data_points/legend，构造 DataRecord。

        Returns:
            图表数据记录列表（entity_type="Chart"）
        """
        # 来源 1：用户上传的图片
        image_files: list[Path] = []
        if uploads_dir.exists():
            image_files = [f for f in sorted(uploads_dir.iterdir())
                           if f.suffix.lower() in _IMAGE_EXTS and f.is_file()]

        # 来源 2：浏览器爬虫截图（TASK-012）
        screenshot_files: list[Path] = []
        if records:
            for r in records:
                if r.get("raw_type") == "screenshot":
                    path = r.get("screenshot_path")
                    if path and Path(path).exists():
                        screenshot_files.append(Path(path))

        all_images = image_files + screenshot_files
        if not all_images:
            return []

        self._emit(progress, type="stage_progress", stage="parse",
                    pct=0.55,
                    message=f"Qwen-VL 提取 {len(all_images)} 张图表"
                            f"（上传 {len(image_files)} + 爬虫截图 {len(screenshot_files)}）")

        out_dir = get_task_output_dir(task.task_id)
        chart_records: list[dict] = []
        for idx, img in enumerate(all_images):
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.55 + 0.1 * (idx + 1) / len(all_images),
                        message=f"图表提取 {img.name} ({idx+1}/{len(all_images)})")
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

    async def _parse_bio_data_records(self, uploads_dir: Path, task: Task,
                                       progress: ProgressCallback | None) -> list[dict]:
        """解析用户上传的生物数据文件（GEO SOFT / PDB / FASTA / 网络文件）。

        扫描 uploads_dir 中非 PDF、非图片的文件，用 detect_format 识别格式，
        分发到对应的 ToolRegistry 解析方法。

        Returns:
            生物数据记录列表
        """
        if not uploads_dir.exists():
            return []

        # 筛选生物数据文件（排除 PDF 和图片，这两类由前序步骤处理）
        bio_files = [f for f in sorted(uploads_dir.iterdir())
                     if f.is_file()
                     and f.suffix.lower() not in _IMAGE_EXTS
                     and f.suffix.lower() != ".pdf"]
        if not bio_files:
            return []

        # 用 detect_format 识别可解析的生物数据文件
        parseable: list[tuple[Path, str]] = []
        for f in bio_files:
            fmt = detect_format(str(f))
            if fmt in _BIO_PARSER_MAP:
                parseable.append((f, fmt))
        if not parseable:
            return []

        self._emit(progress, type="stage_progress", stage="parse",
                    pct=0.7,
                    message=f"解析 {len(parseable)} 个生物数据文件...")

        out_dir = get_task_output_dir(task.task_id)
        bio_records: list[dict] = []
        for idx, (f, fmt) in enumerate(parseable):
            method_name = _BIO_PARSER_MAP[fmt]
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.7 + 0.1 * (idx + 1) / len(parseable),
                        message=f"解析 {fmt} {f.name} ({idx+1}/{len(parseable)})")
            try:
                parser_fn = getattr(self.tools, method_name)
                out_file = out_dir / f"parsed_{f.stem}.json"
                result = await self._to_thread(parser_fn, f, out_file)
                if result.success and result.data:
                    bio_records.extend(self._extract_records(result))
            except Exception as e:
                logger.warning("生物数据解析 %s 失败（已跳过）: %s", f.name, e)
                task.errors.append(f"bio_parse {f.name}: {e}")

        if bio_records:
            self._emit(progress, type="stage_progress", stage="parse",
                        pct=0.8,
                        message=f"✓ 生物数据解析完成：{len(bio_records)} 条")
        return bio_records

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


def _parse_jats_xml(xml_path: Path, task_id: str) -> list[dict]:
    """解析 Europe PMC fullTextXML（JATS 格式）为 DataRecord 列表。

    JATS XML 含结构化全文：article-title/abstract/body/sections/tables/figures。
    本函数提取：
    - 1 条全文 record（title + abstract + body 段落文本）
    - 表格 records（table-wrap，含 caption + 表格内容文本）

    Args:
        xml_path: JATS XML 文件路径
        task_id: 任务 ID
    Returns:
        DataRecord 列表
    """
    import xml.etree.ElementTree as ET
    from app.tools.parsers._base import make_record as _make_rec

    try:
        tree = ET.parse(str(xml_path))
    except Exception as e:
        logger.warning("JATS XML 解析失败 %s: %s", xml_path.name, e)
        return []
    root = tree.getroot()

    def _text(node) -> str:
        """提取节点内所有文本（含子节点），去空白。"""
        if node is None:
            return ""
        return " ".join(t.strip() for t in node.itertext() if t.strip())

    def _find(node, path: str):
        return node.find(path) if node is not None else None

    # 提取标题
    title = _text(_find(root, ".//article-title"))
    # 提取摘要
    abstract_parts = []
    for abs_node in root.findall(".//abstract"):
        for p in abs_node.findall(".//p"):
            t = _text(p)
            if t:
                abstract_parts.append(t)
        # 也可能直接是段落文本
        if not abstract_parts:
            t = _text(abs_node)
            if t:
                abstract_parts.append(t)
    abstract = " ".join(abstract_parts)
    # 提取正文段落
    body_paragraphs = []
    body = _find(root, ".//body")
    if body is not None:
        for p in body.findall(".//p"):
            t = _text(p)
            if t and len(t) > 20:  # 过滤过短片段
                body_paragraphs.append(t)
    body_text = "\n\n".join(body_paragraphs[:50])  # 限制段落数避免过长

    # 提取 DOI/PMID/PMCID（article-meta）
    doi = pmid = pmcid = ""
    for aid in root.findall(".//article-id"):
        aid_type = aid.get("pub-id-type", "")
        val = (aid.text or "").strip()
        if aid_type == "doi":
            doi = val
        elif aid_type == "pmid":
            pmid = val
        elif aid_type == "pmc":
            pmcid = val

    records: list[dict] = []

    # 全文 record
    if title or abstract or body_text:
        fields = {
            "entity_type": "FullText",
            "title": title,
            "abstract": abstract,
            "body_text": body_text,
            "doi": doi,
            "pmid": pmid,
            "pmcid": pmcid,
            "source_xml": xml_path.name,
            "content_length": len(body_text),
        }
        rec = _make_rec(
            task_id=task_id, source_name="europepmc_fulltext",
            fields=fields, file_path=str(xml_path),
            confidence=0.9, method="jats_xml_parse",
            accession=pmcid or doi or pmid,
            source_type="file",
        )
        records.append(rec)

    # 表格 records
    for i, tw in enumerate(root.findall(".//table-wrap")):
        caption = _text(_find(tw, "caption"))
        # 表格内容：提取所有 cell 文本
        cells = []
        for cell in tw.findall(".//td") + tw.findall(".//th"):
            t = _text(cell)
            if t:
                cells.append(t)
        table_text = " | ".join(cells)
        if not (caption or table_text):
            continue
        fields = {
            "entity_type": "Table",
            "caption": caption,
            "table_content": table_text,
            "table_index": i + 1,
            "source_xml": xml_path.name,
        }
        rec = _make_rec(
            task_id=task_id, source_name="europepmc_fulltext",
            fields=fields, file_path=str(xml_path),
            confidence=0.85, method="jats_xml_parse",
            accession=f"{pmcid or xml_path.stem}_table{i+1}",
            source_type="file",
        )
        records.append(rec)

    logger.info("JATS XML %s 解析完成：1 全文 + %d 表格",
                xml_path.name, len(records) - 1)
    return records
