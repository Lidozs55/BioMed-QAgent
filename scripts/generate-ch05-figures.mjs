#!/usr/bin/env node
/**
 * Generate Chapter 5 evaluation figures from authoritative campaign numbers.
 *
 * Data provenance:
 * - 样例1–5 (flash) and 样例1 max: data/gold-campaigns/2026-09-05-gold1-5-retest/
 *   evidence closure.json files (run_usage + event timestamps).
 * - 样例6 (flash/max): docs/evaluation/gold6-10-2026-09-03/runs/gold6-{flash,max-v2}.md
 * - Qoder 对照数值: 2026-09-04 跨环境对照运行的人工记录口径 (as published in ch05 tables).
 *
 * Outputs (docs/latex/figures/):
 * - fig-samples-efficiency-comparison.pdf : 样例1/样例6 × flash/max × BMQ/Qoder cost chart
 * - fig-gold-cost-overview-samples.pdf    : 十样例成本总览
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const figDir = path.join(root, "docs", "latex", "figures");
mkdirSync(figDir, { recursive: true });

const py = `
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager, rcParams
import numpy as np

for fp in ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
           "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"]:
    try:
        font_manager.fontManager.addfont(fp)
    except Exception:
        pass
rcParams["font.sans-serif"] = ["Noto Sans CJK SC", "DejaVu Sans"]
rcParams["axes.unicode_minus"] = False

BLUE = "#1677FF"; GRAY = "#667085"; RED = "#DC2626"

# ---- Figure 1: 样例1/样例6 efficiency (8 units) ----
cases = {
    "样例1": {"flash": {"BMQ": (57.2, 20.909), "QDR": (168, 52.940)},
              "max":   {"BMQ": (14.2, 2.762),  "QDR": (35, 4.474)}},
    "样例6": {"flash": {"BMQ": (98.9, 6.915), "QDR": (175, 67.912)},
              "max":   {"BMQ": (78.0, 7.511),  "QDR": (46, 5.160)}},
}
fig, axes = plt.subplots(1, 2, figsize=(12.5, 5))
for ax, metric, title, unit, fmt in [
    (axes[0], 0, "运行时长", "分钟", lambda v: f"{v:g}"),
    (axes[1], 1, "Token 消耗", "百万", lambda v: f"{v:.1f}M"),
]:
    slots, vals_b, vals_q, labels = [], [], [], []
    for cname, cdata in cases.items():
        for mname in ("flash", "max"):
            slots.append((cname, mname))
            vals_b.append(cdata[mname]["BMQ"][metric])
            vals_q.append(cdata[mname]["QDR"][metric])
    x = np.arange(len(slots)); w = 0.36
    b1 = ax.bar(x - w/2, vals_b, w, label="BioMed QAgent", color=BLUE)
    b2 = ax.bar(x + w/2, vals_q, w, label="Qoder", color=GRAY)
    top = max(vals_b + vals_q)
    ax.set_ylim(0, top * 1.14)
    ax.set_xticks(x)
    ax.set_xticklabels([f"{c}\\n{m}" for c, m in slots], fontsize=10)
    ax.set_title(f"{title}（样例1 / 样例6）", fontsize=13, fontweight="bold")
    ax.set_ylabel(f"{title}（{unit}）", fontsize=11)
    ax.grid(axis="y", alpha=0.3, linestyle="--")
    ax.legend(loc="upper right", fontsize=10)
    for bars in (b1, b2):
        for bar in bars:
            v = bar.get_height()
            ax.text(bar.get_x() + bar.get_width()/2, v + top*0.012, fmt(v),
                    ha="center", va="bottom", fontsize=8.5)
fig.tight_layout()
fig.savefig("${figDir}/fig-samples-efficiency-comparison.pdf", bbox_inches="tight")
plt.close(fig)

# ---- Figure 2: ten-case cost overview ----
names = ["样例1","样例2","样例3","样例4","样例5","样例6","样例7","样例8","样例9","样例10"]
dur   = [57.2, 19.2, 31.1, 8.5, 28.8, 98.9, 36.2, 45.9, 351.2, 108.5]
tok   = [20.91, 1.40, 5.10, 1.86, 3.87, 6.92, 6.35, 10.65, 8.53, 23.17]
colors = [BLUE]*9 + [RED]
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12.5, 6))
y = np.arange(len(names))[::-1]
for ax, vals, title, unit, fmt in [
    (ax1, dur, "运行时长", "分钟", lambda v: f"{v:g}"),
    (ax2, tok, "Token 消耗", "百万", lambda v: f"{v:.1f}"),
]:
    bars = ax.barh(y, vals, color=colors, height=0.62)
    ax.set_yticks(y); ax.set_yticklabels(names, fontsize=10)
    top = max(vals)
    ax.set_xlim(0, top*1.18)
    ax.set_title(f"{title}（{unit}）", fontsize=13, fontweight="bold")
    ax.grid(axis="x", alpha=0.3, linestyle="--")
    for bar, v in zip(bars, vals):
        ax.text(v + top*0.015, bar.get_y()+bar.get_height()/2, fmt(v),
                va="center", fontsize=9)
fig.suptitle("十样例运行成本总览（样例10 未发布阻塞）", fontsize=14, fontweight="bold", y=1.00)
fig.tight_layout()
fig.savefig("${figDir}/fig-gold-cost-overview-samples.pdf", bbox_inches="tight")
plt.close(fig)
print("figures written")
`;

const tmpPy = path.join(root, "data", "gold-campaigns", "2026-09-05-gold1-5-retest", "figures.py");
writeFileSync(tmpPy, py);
execFileSync("uv", ["run", "--with", "matplotlib", "--with", "numpy", "python", tmpPy], {
  stdio: "inherit",
  cwd: root,
});
console.log("done:", path.join(figDir, "fig-samples-efficiency-comparison.pdf"));
console.log("done:", path.join(figDir, "fig-gold-cost-overview-samples.pdf"));
