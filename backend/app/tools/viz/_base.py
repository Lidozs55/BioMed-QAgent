"""可视化公共基类与工具函数。

提供：
- setup_matplotlib()：配置中文字体（SimHei/Microsoft YaHei/Arial Unicode MS）、DPI=150、关闭交互模式
- save_fig()：保存图片并关闭
- load_json()：读取 JSON 输入
- 颜色常量：上调红 / 下调蓝 / 不显著灰 / hub 橙

被 volcano_plot / enrichment_bubble / heatmap / network_plot / extract_chart_data 复用。

模块导入示例：
    from ._base import setup_matplotlib, save_fig, load_json, UP_COLOR
"""
import json
import os


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
