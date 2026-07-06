"""PDF 报告生成脚本（BioMed QAgent Stage 6，可选）。

输入：cleaned DataRecord JSON + 可选 lineage.json + 可选分析结果目录
输出：report.pdf（PDF 格式，中文）

复用 to_report.py 的 build_report() 构造报告结构，再用 reportlab 渲染为 PDF。
reportlab 不可用时输出错误并建议安装该依赖或改用调度器自带的文档处理能力。

中文字体：按顺序探测 Microsoft YaHei / SimHei / SimSun / Arial Unicode MS，
找到首个可用字体后注册为正常字体与加粗字体；找不到时回退到内置 Helvetica
（此时中文会显示为方块，脚本会在 stderr 提示）。

接口：
    python scripts/export/to_pdf.py --input cleaned.json \
        --lineage lineage.json --analysis-dir results/ \
        --out report.pdf --task-id T1

成功输出：{"status":"ok","output":"report.pdf","rows":N}
失败输出：{"status":"error","message":"..."}
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from _base import emit_error, emit_ok, load_lineage, load_records, log_stderr  # noqa: E402
from to_report import build_report  # noqa: E402

# Windows 常见中文字体路径（按优先级探测）
_FONT_CANDIDATES = [
    ("Microsoft YaHei", r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc"),
    ("SimHei", r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simhei.ttf"),
    ("SimSun", r"C:\Windows\Fonts\simsun.ttc", r"C:\Windows\Fonts\simsun.ttc"),
    ("Arial Unicode MS", r"C:\Windows\Fonts\arialuni.ttf", r"C:\Windows\Fonts\arialuni.ttf"),
]


def _register_chinese_fonts():
    """探测并注册中文字体。返回 (normal_font_name, bold_font_name, font_registered)。"""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    for normal_name, normal_path, bold_path in _FONT_CANDIDATES:
        if os.path.isfile(normal_path):
            try:
                pdfmetrics.registerFont(TTFont(normal_name, normal_path))
                bold_name = normal_name + "-Bold"
                if os.path.isfile(bold_path) and bold_path != normal_path:
                    pdfmetrics.registerFont(TTFont(bold_name, bold_path))
                else:
                    bold_name = normal_name  # 退化为普通字体
                return normal_name, bold_name, True
            except Exception:
                continue
    return "Helvetica", "Helvetica-Bold", False


def render_pdf(sections, output_path, task_id=""):
    """用 reportlab 把 sections 渲染为 PDF 文档。"""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer,
                                    Table, TableStyle, PageBreak)

    normal_font, bold_font, ok = _register_chinese_fonts()
    if not ok:
        log_stderr("警告：未找到中文字体，PDF 中文将显示为方块。"
                   "建议在 Windows 环境运行或安装 reportlab 字体包。")

    # 段落样式
    styles = getSampleStyleSheet()
    style_h1 = ParagraphStyle("H1", parent=styles["Heading1"],
                              fontName=bold_font, fontSize=18, leading=24,
                              spaceAfter=10, textColor=colors.HexColor("#1a4d8f"))
    style_h2 = ParagraphStyle("H2", parent=styles["Heading2"],
                              fontName=bold_font, fontSize=14, leading=18,
                              spaceBefore=10, spaceAfter=6,
                              textColor=colors.HexColor("#2c5aa0"))
    style_body = ParagraphStyle("Body", parent=styles["BodyText"],
                                fontName=normal_font, fontSize=10, leading=15,
                                spaceAfter=4)
    style_bullet = ParagraphStyle("Bullet", parent=style_body,
                                  leftIndent=18, bulletIndent=6)
    style_cell = ParagraphStyle("Cell", parent=style_body,
                                fontSize=9, leading=12)

    doc = SimpleDocTemplate(output_path, pagesize=A4,
                            leftMargin=2 * cm, rightMargin=2 * cm,
                            topMargin=2 * cm, bottomMargin=2 * cm,
                            title=f"生物医学数据整合报告 {task_id}".strip(),
                            author="biomed-data-agent")
    story = []
    for sec in sections:
        level = sec["level"]
        title = sec["title"]
        style = style_h1 if level <= 1 else style_h2
        story.append(Paragraph(title, style))
        for b in sec["blocks"]:
            btype = b.get("type")
            if btype == "para":
                story.append(Paragraph(b.get("text", ""), style_body))
            elif btype == "bullets":
                for it in b.get("items", []):
                    story.append(Paragraph(f"• {it}", style_bullet))
            elif btype == "table":
                headers = b.get("headers", [])
                rows = b.get("rows", [])
                data = [[Paragraph(str(h), style_cell) for h in headers]]
                for row in rows:
                    data.append([Paragraph(str(c), style_cell) for c in row[:len(headers)]])
                tbl = Table(data, repeatRows=1, colWidths=None)
                tbl.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2c5aa0")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, -1), normal_font),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1),
                     [colors.white, colors.HexColor("#f0f4fa")]),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ]))
                story.append(tbl)
                story.append(Spacer(1, 6))
        story.append(Spacer(1, 4))
    doc.build(story)


def main():
    import argparse
    parser = argparse.ArgumentParser(prog="to_pdf", description="生成生物医学数据整合 PDF 报告")
    parser.add_argument("--input", required=True, help="输入 cleaned DataRecord JSON")
    parser.add_argument("--lineage", default=None, help="lineage.json 路径（可选）")
    parser.add_argument("--analysis-dir", default=None, help="分析结果目录（可选）")
    parser.add_argument("--out", required=True, help="输出 report.pdf 路径")
    parser.add_argument("--task-id", default="", help="任务 ID")
    args = parser.parse_args()
    try:
        try:
            import reportlab  # noqa: F401
        except ImportError:
            emit_error("reportlab 未安装。建议：(1) 沙箱中执行 pip install reportlab；"
                       "或 (2) 改用调度器自带的文档处理能力生成 PDF 报告。")
        records = load_records(args.input)
        log_stderr(f"加载 {len(records)} 条记录")
        sections = build_report(records, load_lineage(args.lineage), args.task_id,
                                args.analysis_dir, args.out, input_path=args.input)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        render_pdf(sections, args.out, task_id=args.task_id)
        log_stderr(f"PDF 报告已写入 {args.out}（{len(sections)} 节）")
        emit_ok(args.out, rows=len(records), sections=len(sections))
    except Exception as e:
        emit_error(f"PDF 报告生成失败: {e}")


if __name__ == "__main__":
    main()
