"""Markdown 报告生成脚本（BioMed QAgent Stage 6）。

输入：cleaned DataRecord JSON + 可选 lineage.json + 可选分析结果目录
输出：report.md（Markdown 格式，中文）
报告结构：标题 → 执行摘要 → 数据源统计 → 字段映射 → 质量审核 →
数据溯源 → 分析结果 → 输出文件清单 → 附录字段映射表。
接口：
    python scripts/export/to_report.py --input cleaned.json \
        --lineage lineage.json --analysis-dir results/ --out report.md --task-id T1
成功输出：{"status":"ok","output":"report.md","rows":N}
失败输出：{"status":"error","message":"..."}
复用：to_docx.py 通过 import build_report 复用本脚本的内容生成逻辑。
block 类型：para{text} / bullets{items} / table{headers,rows}。
"""
import json
import os
import sys
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import (  # noqa: E402
    emit_error, emit_ok, load_lineage, load_records, log_stderr,
    statistics, utc_now,
)

# 紧凑构造函数：section / bullets / table / para
_S = lambda t, l, b: {"title": t, "level": l, "blocks": b}
_B = lambda items: {"type": "bullets", "items": items}
_T = lambda h, r: {"type": "table", "headers": h, "rows": r}
_P = lambda text: {"type": "para", "text": text}


def _analysis_blocks(analyses):
    """构造第 6 节"分析结果"的 blocks。"""
    if not analyses:
        return [_P("未提供分析结果目录，跳过此节。")]
    blocks = []
    for a in analyses:
        atype = a.get("analysis_type", "unknown")
        blocks.append(_B([f"**{atype}**：{a.get('summary', '')}"]))
        params = a.get("parameters", {}) or {}
        tbl = a.get("stats_table", []) or []
        if atype == "differential_expression" and isinstance(params.get("summary"), dict):
            ps = params["summary"]
            blocks.append(_B([f"  - 上调：{ps.get('up_regulated', '?')} / 下调：{ps.get('down_regulated', '?')}"]))
        elif atype == "enrichment" and tbl:
            blocks.append(_T(["通路", "Overlap", "adj_p_value"],
                             [[t.get("term", ""), t.get("overlap", ""), str(t.get("adj_p_value", ""))] for t in tbl[:5]]))
        elif atype == "ppi_network" and tbl:
            blocks.append(_T(["Hub 基因", "Degree"],
                             [[t.get("gene_symbol", t.get("node", "")), str(t.get("degree", t.get("betweenness", "")))] for t in tbl[:5]]))
    return blocks


def build_report(records, lineage, task_id, analysis_dir, out_path, input_path=None):
    """构造报告结构。返回 list of section dict（供 render_markdown / render_docx 复用）。"""
    stats = statistics(records)
    # 在输入/输出同目录查找 field_mapping.json；加载分析结果；lineage 摘要
    fm = None
    for base in (input_path, out_path):
        if base and (c := (Path(base) if Path(base).is_dir() else Path(base).parent) / "field_mapping.json").is_file():
            try:
                with open(c, "r", encoding="utf-8") as f:
                    fm = json.load(f)
            except Exception:
                pass
            break
    analyses = []
    if analysis_dir and Path(analysis_dir).is_dir():
        for fp in sorted(Path(analysis_dir).glob("*.json")):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    analyses.append(data.get("result") if isinstance(data.get("result"), dict) else data)
            except Exception:
                continue
    if lineage:
        nodes = lineage.get("nodes", []) or []
        ids = {n.get("node_id") for n in nodes}
        broken = sum(1 for n in nodes for i in (n.get("input_node_ids") or []) if i and i not in ids)
        seen = list(dict.fromkeys(n.get("operation_type", "") for n in nodes if n.get("operation_type", "")))
        node_count, dag_ok, key_path = len(nodes), broken == 0, " → ".join(seen)
    else:
        node_count, dag_ok, key_path = 0, None, ""
    src_conf = {}
    for r in records:
        s = (r.get("source_ref", {}) or {}).get("source_name", "unknown")
        src_conf.setdefault(s, []).append(float(r.get("extraction_confidence", 0) or 0))
    src_summary = "、".join(f"{k} ({v})" for k, v in stats["by_source"].items()) or "无"
    src_rows = [[s, str(c), f"{sum(src_conf[s])/len(src_conf[s]):.2f}"] for s, c in stats["by_source"].items()]
    low_conf = sum(1 for r in records if float(r.get("extraction_confidence", 1) or 1) < 0.5)
    flagged = [f"`{r.get('record_id', '?')}` — {';'.join(r.get('quality_flags', []) or [])}" for r in records if r.get("quality_flags")]

    sections = [
        _S("生物医学数据整合报告", 1, [_B([
            f"**任务 ID**: {task_id or '(未指定)'}",
            f"**生成时间**: {utc_now()}",
            f"**数据源数量**: {len(stats['by_source'])}",
            f"**总记录数**: {stats['total']}"])]),
        _S("1. 执行摘要", 2, [_B([
            f"总记录数：{stats['total']}",
            f"平均置信度：{stats['avg_confidence']:.2f}",
            f"涉及数据源：{src_summary}",
            f"需要人工审核的记录：{stats['flagged_count']}",
            f"冲突记录：{stats['conflict_count']}"])]),
        _S("2. 数据源统计", 2, [_T(["数据源", "记录数", "平均置信度"], src_rows)]),
    ]
    # 3. 字段映射
    if fm:
        fm_blocks = []
        for item in fm[:10]:
            srcs = ", ".join(s.get("source_name", "") for s in (item.get("source_mappings") or []))
            fm_blocks.append(_B([f"**{item.get('unified_field_name', '')}** ({item.get('unified_field_label', '')})：单位 `{item.get('unified_unit') or '—'}`，来源：{srcs}"]))
        if len(fm) > 10:
            fm_blocks.append(_P(f"… 共 {len(fm)} 个字段，完整列表见附录。"))
    else:
        fm_blocks = [_P("未找到 field_mapping.json，跳过此节。")]
    sections.append(_S("3. 字段映射", 2, fm_blocks))
    # 4. 质量审核
    review = [f"冲突记录：{stats['conflict_count']}", f"低置信度记录（< 0.5）：{low_conf}",
              f"被标记记录总数：{stats['flagged_count']}", "需要审核的记录："]
    review.extend(flagged[:20])
    if len(flagged) > 20:
        review.append(f"…（共 {len(flagged)} 条，已截断显示）")
    sections.append(_S("4. 质量审核", 2, [_B(review)]))
    # 5. 数据溯源
    sections.append(_S("5. 数据溯源", 2, [_B([
        f"溯源节点数：{node_count}",
        f"DAG 验证：{'通过' if dag_ok else '存在断链'}",
        f"关键路径：{key_path or '（无 lineage）'}"])]))
    # 6. 分析结果
    sections.append(_S("6. 分析结果", 2, _analysis_blocks(analyses)))

    # 7. 输出文件清单
    out_dir = Path(out_path).parent if out_path else Path(".")
    files = [f"`{n}`" for n in ["data.csv", "data.xlsx", "lineage.json", "field_mapping.json", "report.md"] if (out_dir / n).exists()]
    charts_dir = out_dir / "charts"
    if charts_dir.is_dir():
        files.extend(f"`charts/{p.name}`" for p in sorted(charts_dir.glob("*.png")))
    if not files:
        files = ["（暂无其他输出文件）"]
    sections.append(_S("7. 输出文件清单", 2, [_B(files)]))

    # 8. 附录：完整字段映射表
    if fm:
        rows = [[i.get("unified_field_name", ""), i.get("unified_field_label", ""), i.get("unified_unit") or "—",
                 ", ".join(s.get("source_name", "") for s in (i.get("source_mappings") or []))] for i in fm]
        sections.append(_S("附录：完整字段映射表", 2, [_T(["统一字段", "标签", "单位", "来源"], rows)]))
    return sections


def render_markdown(sections):
    """把 sections 渲染为 Markdown 字符串。"""
    lines = []
    for sec in sections:
        lines.append("#" * sec["level"] + " " + sec["title"])
        lines.append("")
        for b in sec["blocks"]:
            if b["type"] == "para":
                lines += [b["text"], ""]
            elif b["type"] == "bullets":
                lines += [f"- {it}" for it in b["items"]] + [""]
            elif b["type"] == "table":
                lines.append("| " + " | ".join(b["headers"]) + " |")
                lines.append("|" + "|".join(["---"] * len(b["headers"])) + "|")
                lines += ["| " + " | ".join(str(c) for c in row) + " |" for row in b["rows"]]
                lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main():
    import argparse
    parser = argparse.ArgumentParser(prog="to_report", description="生成生物医学数据整合 Markdown 报告")
    parser.add_argument("--input", required=True, help="输入 cleaned DataRecord JSON")
    parser.add_argument("--lineage", default=None, help="lineage.json 路径（可选）")
    parser.add_argument("--analysis-dir", default=None, help="分析结果目录（可选）")
    parser.add_argument("--out", required=True, help="输出 report.md 路径")
    parser.add_argument("--task-id", default="", help="任务 ID")
    args = parser.parse_args()
    try:
        records = load_records(args.input)
        log_stderr(f"加载 {len(records)} 条记录")
        sections = build_report(records, load_lineage(args.lineage), args.task_id,
                                args.analysis_dir, args.out, input_path=args.input)
        md = render_markdown(sections)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(md)
        log_stderr(f"Markdown 报告已写入 {args.out}（{len(sections)} 节）")
        emit_ok(args.out, rows=len(records), sections=len(sections))
    except Exception as e:
        emit_error(f"Markdown 报告生成失败: {e}")


if __name__ == "__main__":
    main()
