"""LLM 报告生成 Agent — 整合多源数据生成综合研究报告。

职责：
- 接收清洗后的数据记录、分析结果、质量审查、实体识别等上下文
- 调用 LLM（qwen-max）生成类似 report.html 的综合研究报告
- 报告包含：执行摘要、数据源分析、核心发现、机制解读、结论建议
- 输出 HTML 格式，可直接在前端 iframe 中展示

设计理念：
- 不是简单数据罗列，而是 LLM 驱动的科学叙事
- 整合多源异构数据，提供研究级洞察
- 保留数据溯源和质量评估
"""
from __future__ import annotations

import asyncio
import json
import logging

from app.llm.client import DashScopeClient
from app.config import MODEL_STRONG

logger = logging.getLogger(__name__)


class LLMReporter:
    """LLM 驱动的综合研究报告生成器。"""

    def __init__(self, llm: DashScopeClient | None = None):
        self.llm = llm or DashScopeClient()

    async def generate_report(
        self,
        research_goal: str,
        records: list[dict],
        entities: dict,
        analysis: dict,
        review: dict,
        task_id: str = "",
        domain: str = "",
    ) -> str:
        """生成综合研究报告 HTML。

        Args:
            research_goal: 研究目标
            records: 清洗后的数据记录列表
            entities: 实体识别结果 {"genes": [...], "compounds": [...], ...}
            analysis: 分析结果 {"ppi_network": {...}, "enrichment": {...}, ...}
            review: 质量审查结果
            task_id: 任务 ID
            domain: 领域分类

        Returns:
            HTML 格式的综合研究报告

        Raises:
            RuntimeError: 如果 DASHSCOPE_API_KEY 未配置
            Exception: LLM 调用失败的原始异常（不回退，由调用方处理）
        """
        if not self.llm.is_available():
            raise RuntimeError(
                "DASHSCOPE_API_KEY 未配置，无法生成 LLM 综合研究报告。"
                "请配置环境变量后重试。"
            )

        # 准备 LLM 输入摘要（避免超长）
        context_summary = self._build_context_summary(
            research_goal, records, entities, analysis, review
        )

        prompt = self._build_prompt(context_summary, research_goal)

        # 调用 LLM 生成报告内容（Markdown 格式）
        # 用 asyncio.to_thread 包装同步调用，避免阻塞事件循环
        report_md = await asyncio.to_thread(
            self.llm.chat,
            messages=[
                {"role": "system", "content": self._system_prompt()},
                {"role": "user", "content": prompt},
            ],
            model=MODEL_STRONG,
            temperature=0.4,
            max_tokens=8192,
        )

        # 将 Markdown 转为 HTML 并包装在完整页面中
        html = self._wrap_in_html(report_md, research_goal, task_id,
                                    records, entities, review, domain)
        logger.info("LLM 报告生成成功，长度=%d", len(html))
        return html

    def _system_prompt(self) -> str:
        return """你是一位资深的生物医学研究分析师。你的任务是基于多源数据整合结果，撰写一份高质量的综合研究报告。

报告要求：
1. **科学叙事**：不是数据罗列，而是有逻辑的研究叙事，类似学术论文的 Discussion 部分
2. **多源整合**：整合文献、数据库、分析结果，形成连贯结论
3. **机制解读**：对 PPI 网络、富集分析、药物-靶点等结果进行生物学意义解读
4. **批判性思考**：指出数据局限性、冲突点、不确定性
5. **可追溯**：关键结论标注数据来源

**关键约束（避免常见错误）：**
- **结论必须基于"分析结果"部分的实际证据**，而非"规划阶段识别的实体"。规划阶段实体仅是假设，需分析结果验证后才能作为结论。若某实体出现在规划但未出现在分析结果中，应说明"该实体未能通过本次分析验证"。
- **不要建议"引入"已检索的数据源**。上下文已明确列出"已检索"的数据源（含无记录的），建议只能针对未检索的源或新的检索策略。
- **不要将字段对齐/数据清洗的实现细节作为研究建议**。如"unknown_field"是系统内部标记，不应出现在报告中。
- **数据源建议应具体可执行**，例如"建议补充检索 ClinicalTrials.gov 的临床试验数据"而非泛泛说"引入更多数据源"。

输出格式：Markdown，使用 ## 作为章节标题，包含：
- 执行摘要（3-5 句话概括核心发现）
- 数据来源与分析方法
- 核心发现（分点详述，含数据支撑）
- 生物学意义/机制解读
- 数据质量与局限性
- 结论与建议

使用中文撰写。如果涉及基因/化合物名称，首次出现时附上英文缩写。
不要输出 ```markdown 代码块标记，直接输出 Markdown 文本。"""

    def _build_prompt(self, context_summary: str, research_goal: str) -> str:
        return f"""# 研究目标
{research_goal}

# 数据整合上下文
{context_summary}

# 任务
基于以上多源数据整合结果，撰写一份综合研究报告。报告应：
1. 回应研究目标，给出基于数据的结论
2. 整合不同来源的数据，指出一致性和冲突点
3. 解读分析结果的生物学意义
4. 评估数据质量和完整性
5. 提出后续研究方向建议

请直接输出 Markdown 格式的报告内容（不要包裹在代码块中）。"""

    def _build_context_summary(
        self,
        research_goal: str,
        records: list[dict],
        entities: dict,
        analysis: dict,
        review: dict,
    ) -> str:
        """构建 LLM 输入上下文摘要（控制长度）。

        设计要点（修复 ABC 三类报告质量问题）：
        - A: 不暴露 quality_flags 原始标记名，改为人类可读描述
        - B: 明确区分"已检索数据源"与"无记录/失败数据源"
        - C: 区分 planning 假设实体 vs analysis 实际验证实体
        """
        parts: list[str] = []
        parts.append(self._summarize_sources(records, review))
        parts.append(self._summarize_entities(entities))
        parts.append(self._summarize_records(records))
        parts.append(self._summarize_analysis(analysis))
        parts.append(self._summarize_review(review))
        return "\n".join(p for p in parts if p)

    @staticmethod
    def _summarize_sources(records: list[dict], review: dict) -> str:
        """B 修复：明确标注已检索 + 无记录的数据源。"""
        sources_with_data: dict[str, int] = {}
        for r in records:
            src = r.get("source_ref", {}).get("source_name", "unknown")
            sources_with_data[src] = sources_with_data.get(src, 0) + 1
        # review 中可能记录了检索失败的数据源
        sources_no_data: set[str] = set()
        known_sources = ("pubmed", "openalex", "semantic_scholar", "arxiv",
                         "disgenet", "string", "tcmsp", "kegg", "pdb", "drugbank")
        for f in (review.get("key_findings", []) if review else []):
            if isinstance(f, str) and ("检索失败" in f or "无记录" in f):
                for src in known_sources:
                    if src in f.lower() and src not in sources_with_data:
                        sources_no_data.add(src)

        parts = [f"## 数据源统计（已检索）\n共 {len(records)} 条记录。"]
        if sources_with_data:
            parts.append("**有记录的数据源：**")
            for src, cnt in sorted(sources_with_data.items(), key=lambda x: -x[1]):
                parts.append(f"- {src}: {cnt} 条")
        if sources_no_data:
            parts.append(f"\n**已检索但无记录/失败的数据源：** {', '.join(sorted(sources_no_data))}")
            parts.append("（注意：上述数据源已尝试检索，无需在建议中重复提及『引入』它们）")
        return "\n".join(parts)

    @staticmethod
    def _summarize_entities(entities: dict) -> str:
        """C 修复：标注为 planning 阶段假设实体。"""
        if not entities:
            return ""
        parts = ["\n## 规划阶段识别的实体（LLM 假设，需分析结果验证）"]
        for cat, items in entities.items():
            if items:
                parts.append(f"- {cat}: {', '.join(items[:15])}")
        return "\n".join(parts)

    @staticmethod
    def _summarize_records(records: list[dict]) -> str:
        """A 修复：过滤 unknown_field 标记名，用人类可读描述。"""
        parts = ["\n## 代表性数据记录（前 20 条摘要）"]
        unknown_field_count = sum(
            1 for r in records if "unknown_field" in (r.get("quality_flags") or [])
        )
        for r in records[:20]:
            fields = r.get("fields", {})
            src = r.get("source_ref", {}).get("source_name", "")
            title = (fields.get("title") or fields.get("compound_name")
                     or fields.get("gene_symbol") or fields.get("name") or "")[:80]
            conf = r.get("extraction_confidence", 0)
            parts.append(f"- [{src}] {title} (置信度={conf:.0%})")
        if unknown_field_count > 0:
            parts.append(
                f"\n（注：{unknown_field_count} 条记录含未对齐到标准字典的字段，"
                "已在清洗阶段保留原值并标记，不影响分析，无需在报告中作为『问题』提出。）"
            )
        return "\n".join(parts)

    @staticmethod
    def _summarize_analysis(analysis: dict) -> str:
        """C 修复：突出实际验证的实体与证据。"""
        if not analysis:
            return ""
        parts = ["\n## 分析结果（实际验证的证据，结论应优先基于此部分）"]
        verified: dict[str, list[str]] = {}
        for atype, result in analysis.items():
            if not isinstance(result, dict):
                continue
            parts.append(f"\n### {atype}")
            if summary := result.get("summary", ""):
                parts.append(f"摘要: {summary}")
            if params := result.get("parameters", {}):
                parts.append(f"参数: {json.dumps(params, ensure_ascii=False)[:200]}")
            if stats := result.get("stats_table", []):
                parts.append("统计表（前 10 条）:")
                for row in stats[:10]:
                    parts.append(f"  - {json.dumps(row, ensure_ascii=False)[:150]}")
            LLMReporter._collect_verified_entities(result, verified)
        if verified:
            parts.append("\n### 分析中实际验证的实体（区别于规划阶段假设）")
            for cat, items in verified.items():
                if items:
                    parts.append(f"- {cat}: {', '.join(items[:20])}")
        return "\n".join(parts)

    @staticmethod
    def _summarize_review(review: dict) -> str:
        """质量审查摘要。"""
        if not review:
            return ""
        parts = ["\n## 质量审查",
                 f"- 总体质量: {review.get('overall_quality', '—')}",
                 f"- 完整度: {review.get('completeness_score', '—')}"]
        if findings := review.get("key_findings", []):
            parts.append("- 关键发现:")
            parts.extend(f"  - {f}" for f in findings[:5])
        if recs := review.get("recommendations", []):
            parts.append("- 改进建议:")
            parts.extend(f"  - {r}" for r in recs[:3])
        return "\n".join(parts)

    @staticmethod
    def _collect_verified_entities(result: dict, verified: dict[str, list[str]]) -> None:
        """从分析结果中提取实际验证的实体（基因/化合物/通路）。

        统一处理三种结构：PPI 节点、富集通路、差异表达基因表。
        """
        # (source_keys, target_category, item_key_candidates)
        specs = [
            # PPI 网络节点 → genes
            (("nodes",), "genes", ("id", "gene_symbol")),
            # 富集通路 → pathways
            (("pathways", "enriched_terms"), "pathways", ("name", "term")),
            # 差异表达表 → deg_genes
            (("stats_table",), "deg_genes", ("gene", "gene_symbol")),
        ]
        for src_keys, category, item_keys in specs:
            items_raw = None
            for sk in src_keys:
                val = result.get(sk)
                if sk == "nodes":
                    val = val or result.get("network", {}).get("nodes")
                if isinstance(val, list):
                    items_raw = val
                    break
            if not items_raw:
                continue
            names: list[str] = []
            for item in items_raw:
                if not isinstance(item, dict):
                    continue
                for ik in item_keys:
                    name = item.get(ik, "")
                    if name:
                        names.append(str(name))
                        break
            if names:
                bucket = verified.setdefault(category, [])
                for n in names:
                    if n not in bucket:
                        bucket.append(n)

    def _wrap_in_html(
        self,
        report_md: str,
        research_goal: str,
        task_id: str,
        records: list[dict],
        entities: dict,
        review: dict,
        domain: str = "",
    ) -> str:
        """将 Markdown 报告包装为完整 HTML 页面。"""
        # 简易 Markdown → HTML 转换（不依赖第三方库）
        report_html = self._md_to_html(report_md)

        # 数据溯源摘要
        sources = {}
        for r in records:
            src = r.get("source_ref", {}).get("source_name", "unknown")
            sources[src] = sources.get(src, 0) + 1
        source_items = "".join(
            f'<div class="source-item"><span class="name">{src}</span>'
            f'<span class="count">{cnt}</span><span>条</span></div>'
            for src, cnt in sorted(sources.items(), key=lambda x: -x[1])
        )

        # 实体标签
        entity_tags = ""
        for cat, items in entities.items():
            if items:
                entity_tags += f'<span class="tag">{cat}: {", ".join(items[:8])}</span> '

        # 质量审查卡片
        review_card = ""
        if review:
            review_card = f"""
            <div class="card review-card">
                <h2>质量审查</h2>
                <div class="review-grid">
                    <div><strong>总体质量</strong><span class="quality-badge {review.get('overall_quality', '').lower()}">{review.get('overall_quality', '—')}</span></div>
                    <div><strong>完整度</strong><span>{review.get('completeness_score', '—')}</span></div>
                </div>
                {''.join(f'<p>• {f}</p>' for f in review.get('key_findings', [])[:5])}
            </div>"""

        return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>综合研究报告 — {research_goal[:50]}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
                background: #f5f7fa; color: #2c3e50; line-height: 1.8; padding: 20px; }}
        .container {{ max-width: 1000px; margin: 0 auto; }}
        h1 {{ color: #1a1a2e; margin-bottom: 8px; font-size: 24px; }}
        h2 {{ color: #16213e; margin: 24px 0 12px; border-bottom: 2px solid #0f3460; padding-bottom: 8px; font-size: 20px; }}
        h3 {{ color: #0f3460; margin: 18px 0 10px; font-size: 16px; }}
        p {{ margin: 8px 0; }}
        ul, ol {{ margin: 8px 0 8px 24px; }}
        li {{ margin: 4px 0; }}
        strong {{ color: #1a1a2e; }}
        .card {{ background: white; border-radius: 10px; padding: 24px; margin: 16px 0;
                  box-shadow: 0 2px 12px rgba(0,0,0,0.08); }}
        .header {{ background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                   color: white; padding: 28px; border-radius: 10px; margin-bottom: 20px; }}
        .header h1 {{ color: white; }}
        .header .meta {{ opacity: 0.8; font-size: 13px; margin-top: 8px; }}
        .summary {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 16px 0; }}
        .stat {{ background: #16213e; color: white; padding: 18px; border-radius: 10px; text-align: center; }}
        .stat .num {{ font-size: 32px; font-weight: bold; }}
        .stat .label {{ font-size: 12px; opacity: 0.8; margin-top: 4px; }}
        .tag {{ display: inline-block; background: #e8f0fe; color: #1a73e8;
                padding: 4px 12px; border-radius: 16px; margin: 3px; font-size: 12px; }}
        .source-list {{ display: flex; flex-wrap: wrap; gap: 8px; }}
        .source-item {{ background: #f0f4ff; padding: 8px 14px; border-radius: 6px;
                        font-size: 13px; display: flex; gap: 6px; align-items: center; }}
        .source-item .count {{ font-weight: bold; color: #0f3460; }}
        .review-card {{ border-left: 4px solid #faad14; }}
        .review-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }}
        .quality-badge {{ padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: bold; }}
        .quality-badge.high {{ background: #d4edda; color: #155724; }}
        .quality-badge.medium {{ background: #fff3cd; color: #856404; }}
        .quality-badge.low {{ background: #f8d7da; color: #721c24; }}
        .report-body {{ font-size: 15px; }}
        .report-body h2 {{ margin-top: 32px; }}
        .footer {{ text-align: center; color: #999; font-size: 12px; margin: 32px 0; padding: 16px; }}
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>综合研究报告</h1>
        <p><strong>研究目标：</strong>{research_goal}</p>
        <div class="meta">任务 ID: {task_id} | 领域: {domain or '未分类'} | 由 LLM 生成</div>
    </div>

    <div class="summary">
        <div class="stat"><div class="num">{len(records)}</div><div class="label">总记录数</div></div>
        <div class="stat"><div class="num">{len(sources)}</div><div class="label">数据源数</div></div>
        <div class="stat"><div class="num">{sum(len(v) for v in entities.values())}</div><div class="label">识别实体</div></div>
        <div class="stat"><div class="num">{sum(1 for r in records if r.get('extraction_confidence', 0) >= 0.8)}</div><div class="label">高置信记录</div></div>
    </div>

    {f'<div class="card"><h2>识别实体</h2><div>{entity_tags}</div></div>' if entity_tags else ''}

    <div class="card">
        <h2>数据来源</h2>
        <div class="source-list">{source_items}</div>
    </div>

    {review_card}

    <div class="card report-body">
        {report_html}
    </div>

    <div class="footer">
        BioMed QAgent · LLM 驱动综合研究报告 · {task_id}
    </div>
</div>
</body>
</html>"""

    def _md_to_html(self, md: str) -> str:
        """简易 Markdown → HTML 转换（不依赖第三方库）。"""
        import re
        html = md
        # 转义 HTML 特殊字符（保留 markdown 标记）
        # html = html.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        # 标题
        html = re.sub(r"^### (.+)$", r"<h3>\1</h3>", html, flags=re.MULTILINE)
        html = re.sub(r"^## (.+)$", r"<h2>\1</h2>", html, flags=re.MULTILINE)
        html = re.sub(r"^# (.+)$", r"<h2>\1</h2>", html, flags=re.MULTILINE)

        # 粗体和斜体
        html = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html)
        html = re.sub(r"\*(.+?)\*", r"<em>\1</em>", html)

        # 列表
        lines = html.split("\n")
        result = []
        in_ul = False
        in_ol = False
        for line in lines:
            if re.match(r"^[\-\*] (.+)", line):
                if in_ol:
                    result.append("</ol>")
                    in_ol = False
                if not in_ul:
                    result.append("<ul>")
                    in_ul = True
                result.append(f"<li>{line[2:]}</li>")
            elif re.match(r"^\d+\. (.+)", line):
                if in_ul:
                    result.append("</ul>")
                    in_ul = False
                if not in_ol:
                    result.append("<ol>")
                    in_ol = True
                m = re.match(r"^\d+\. (.+)", line)
                result.append(f"<li>{m.group(1)}</li>")
            else:
                if in_ul:
                    result.append("</ul>")
                    in_ul = False
                if in_ol:
                    result.append("</ol>")
                    in_ol = False
                if line.strip():
                    # 段落
                    if not line.startswith("<h"):
                        result.append(f"<p>{line}</p>")
                    else:
                        result.append(line)
        if in_ul:
            result.append("</ul>")
        if in_ol:
            result.append("</ol>")

        return "\n".join(result)
