"""可视化公共基类与工具函数。

提供：
- setup_matplotlib()：配置中文字体（SimHei/Microsoft YaHei/Arial Unicode MS）、DPI=150、关闭交互模式
- save_fig()：保存图片并关闭
- load_json()：读取 JSON 输入
- setup_cli()：返回预设 --input/--out/--title 的 ArgumentParser
- 颜色常量：上调红 / 下调蓝 / 不显著灰 / hub 橙
- emit_ok / emit_error：标准化 stdout 输出

被 volcano_plot / enrichment_bubble / heatmap / network_plot / extract_chart_data 复用。
脚本以 ``python scripts/viz/xxx.py`` 直接运行时，本目录会被加入 sys.path。
"""
import argparse
import json
import os
import sys


# ===== 颜色常量 =====
UP_COLOR = "#e74c3c"      # 上调红
DOWN_COLOR = "#3498db"    # 下调蓝
NS_COLOR = "#95a5a6"      # 不显著灰
HUB_COLOR = "#f39c12"     # hub 橙


def setup_matplotlib():
    """配置 matplotlib：中文字体、DPI=150、关闭交互模式。

    依次尝试 SimHei / Microsoft YaHei / Arial Unicode MS，避免中文显示为方块。
    必须在 import pyplot 之前调用 matplotlib.use("Agg")。
    """
    import matplotlib
    matplotlib.use("Agg")  # 非交互后端，适合无显示沙箱
    import matplotlib.pyplot as plt

    candidates = ["SimHei", "Microsoft YaHei", "Arial Unicode MS", "DejaVu Sans"]
    try:
        from matplotlib import font_manager
        available = {f.name for f in font_manager.fontManager.ttflist}
        chosen = next((c for c in candidates if c in available), candidates[-1])
    except Exception:
        chosen = candidates[0]
    plt.rcParams["font.sans-serif"] = [chosen]
    plt.rcParams["axes.unicode_minus"] = False  # 负号正常显示
    plt.rcParams["figure.dpi"] = 150
    plt.ioff()
    return plt


def save_fig(fig, output_path, dpi=150):
    """保存图片到 output_path（自动建父目录）并关闭 fig。"""
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    fig.savefig(output_path, dpi=dpi, bbox_inches="tight")
    import matplotlib.pyplot as plt
    plt.close(fig)


def load_json(path):
    """读取 JSON 文件并返回解析后的对象。"""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def setup_cli(name, description):
    """返回 argparse.ArgumentParser，预设 --input/--out/--title 通用参数。"""
    parser = argparse.ArgumentParser(prog=name, description=description)
    parser.add_argument("--input", required=True, help="输入分析结果 JSON 路径")
    parser.add_argument("--out", required=True, help="输出 PNG 图片路径")
    parser.add_argument("--title", default="", help="图表标题（可选）")
    return parser


def emit_ok(chart, data_points=0, **extra):
    """输出成功 JSON 到 stdout：{"status":"ok","chart":...,"data_points":N}。"""
    payload = {"status": "ok", "chart": chart, "data_points": int(data_points)}
    payload.update(extra)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_error(message):
    """输出错误 JSON 到 stdout，并以 exit code 1 退出。"""
    sys.stdout.write(json.dumps({"status": "error", "message": message}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(1)
