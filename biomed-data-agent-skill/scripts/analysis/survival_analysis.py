"""生存分析（Kaplan-Meier + log-rank 检验，基于 TCGA 队列）。

输入：
  --gene：要分析的基因 symbol（必填）
  --cohort：TCGA 队列名，如 TCGA-PAAD（胰腺癌），默认 TCGA-PAAD
  --input：可选，已有 TCGA 表达+临床数据 JSON
           结构：{"expression": {sample: value}, "clinical": [{sample, time_months, event}]}
           （clinical 也接受 time 字段代替 time_months；event 1=死亡 0=删失）
功能：
  1. 若 --input 提供，从文件读取表达矩阵与临床数据
  2. 否则调用 TCGA GDC API 检索该 cohort 的临床生存数据（max 200 样本避免超时），
     并尝试获取该基因的样本级表达（GDC 不提供轻量 per-gene 表达端点，常降级）
  3. 按基因表达中位数分高/低两组
  4. 计算 Kaplan-Meier 生存曲线
  5. log-rank 检验（lifelines 不可用时降级为纯 Python χ² 近似）
  6. 计算 Hazard Ratio（Cox 比例风险；lifelines 不可用降级为 O/E 比）
输出：符合 survival_result.schema.json 的 dict（直接构造，不调用 make_result）
  由 save_result() 包装为 {"status":"ok","result":{...},"summary":"..."} 信封。
降级：
  - TCGA API 不可用 / 表达缺失 → significance=insufficient_data
  - lifelines 不可用 → 纯 Python KM 估计 + log-rank χ² 近似

用法：
    python scripts/analysis/survival_analysis.py \
        --gene TP53 --cohort TCGA-PAAD --out surv.json --task-id t1
    python scripts/analysis/survival_analysis.py \
        --gene KRAS --input tcga_expr_clin.json --out surv.json
"""
from __future__ import annotations

import json
import math
import sys

from _base import (
    log_stderr,
    save_error,
    save_result,
    setup_cli,
    utc_now,
)

GDC_CASES_URL = "https://api.gdc.cancer.gov/cases"
GDC_GENES_URL = "https://api.gdc.cancer.gov/genes"
HEADERS = {"User-Agent": "BioMedQAgent/1.0"}
DAYS_PER_MONTH = 30.4375


# ===== 数据加载 / GDC API =====

def _load_expression_clinical(path):
    """从 --input JSON 读取表达矩阵与临床数据。

    支持结构：{"expression": {sample: value}|[{sample, value}], "clinical": [...]}
    或信封 {"status":"ok","result":{...}}。
    """
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "result" in data and isinstance(data["result"], dict):
        data = data["result"]
    if not isinstance(data, dict):
        return None, None
    expression = data.get("expression")
    if isinstance(expression, list):
        expression = {r["sample"]: r["value"] for r in expression
                      if isinstance(r, dict) and "sample" in r and "value" in r}
    if not isinstance(expression, dict):
        expression = None
    clinical = data.get("clinical")
    if not isinstance(clinical, list):
        clinical = None
    return expression, clinical


def _fetch_gdc_clinical(cohort, max_samples):
    """调用 GDC /cases 获取临床生存数据。返回 [{sample, time_months, event}]。"""
    import requests
    payload = {
        "filters": {
            "op": "in",
            "content": {"field": "project.project_id", "value": [cohort]},
        },
        "fields": "submitter_id,diagnoses.vital_status,"
                  "diagnoses.days_to_death,diagnoses.days_to_last_follow_up",
        "size": max_samples,
    }
    r = requests.post(GDC_CASES_URL, json=payload,
                      headers=HEADERS, timeout=120)
    r.raise_for_status()
    data = r.json()
    hits = data.get("data", {}).get("hits", []) or []
    out = []
    for h in hits:
        sid = h.get("submitter_id") or h.get("id")
        diag = h.get("diagnoses")
        if isinstance(diag, list):
            diag = diag[0] if diag else {}
        elif not isinstance(diag, dict):
            diag = {}
        vital = diag.get("vital_status", "")
        d2d = diag.get("days_to_death")
        d2lfu = diag.get("days_to_last_follow_up")
        event = 1 if str(vital).lower() == "dead" else 0
        days = d2d if event == 1 else d2lfu
        if days is None:
            continue
        try:
            days = float(days)
        except (TypeError, ValueError):
            continue
        if days <= 0:
            continue
        out.append({"sample": sid,
                    "time_months": round(days / DAYS_PER_MONTH, 4),
                    "event": event})
    return out


def _fetch_gdc_expression(gene, cohort, samples, max_samples):
    """尝试通过 GDC API 获取该基因在样本中的表达（best-effort，常返回 None 降级）。

    GDC 不提供轻量的 per-gene per-sample 表达端点；本函数先 /genes 查询基因 UUID，
    若无法直接获取样本级表达值则返回 None，由调用方降级为 insufficient_data。
    建议通过 --input 提供预先准备好的表达矩阵以获得真实结果。
    """
    import requests
    try:
        r = requests.get(GDC_GENES_URL,
                         params={"filter": json.dumps({
                             "op": "in",
                             "content": {"field": "symbol", "value": [gene]}
                         })}, headers=HEADERS, timeout=60)
        r.raise_for_status()
        gdata = r.json()
        hits = gdata.get("data", {}).get("hits", []) or []
        if not hits:
            log_stderr(f"GDC 未找到基因 {gene}，表达数据降级")
            return None
        # GDC 样本级表达需下载 HTSeq 文件（每样本一个，过重），此处降级
        log_stderr("GDC 表达获取需下载 HTSeq 文件，跳过（建议用 --input 提供表达矩阵）")
        return None
    except Exception as e:
        log_stderr(f"GDC 表达查询失败，降级: {e}")
        return None


# ===== Kaplan-Meier 估计（纯 Python） =====

def _km_estimate(times, events):
    """Kaplan-Meier 估计。返回 [(time, survival)] 升序列表（含起点 0.0, 1.0）。"""
    if not times:
        return [(0.0, 1.0)]
    n = len(times)
    order = sorted(range(n), key=lambda i: times[i])
    points = [(0.0, 1.0)]
    s = 1.0
    i = 0
    while i < n:
        t = times[order[i]]
        d = 0  # 事件数
        j = i
        while j < n and times[order[j]] == t:
            if events[order[j]] == 1:
                d += 1
            j += 1
        at_risk = n - i
        if d > 0 and at_risk > 0:
            s = s * (1.0 - d / at_risk)
        points.append((t, s))
        i = j
    return points


def _median_survival(km_points):
    """从 KM 曲线找中位生存时间（S 首次 <= 0.5，线性插值）。未达到返回 0.0。"""
    if len(km_points) < 2:
        return 0.0
    for i in range(1, len(km_points)):
        t, s = km_points[i]
        if s <= 0.5:
            t0, s0 = km_points[i - 1]
            if s0 == s:
                return float(t)
            return float(t0 + (0.5 - s0) * (t - t0) / (s - s0))
    return 0.0


def _merge_km_curves(km_high, km_low):
    """合并两组 KM 曲线为统一时间点列表（forward-fill 阶梯函数）。"""
    all_times = sorted(set(t for t, _ in km_high) | set(t for t, _ in km_low))
    dh = dict(km_high)
    dl = dict(km_low)
    out = []
    sh = 1.0
    sl = 1.0
    for t in all_times:
        if t in dh:
            sh = dh[t]
        if t in dl:
            sl = dl[t]
        out.append({"time": round(float(t), 6),
                    "survival_high": round(float(sh), 6),
                    "survival_low": round(float(sl), 6)})
    return out


# ===== log-rank 检验 + Hazard Ratio =====

def _normal_sf_two_sided(z):
    """标准正态双尾 p 值（纯 Python，用 math.erf）。"""
    try:
        cdf = 0.5 * (1.0 + math.erf(abs(z) / math.sqrt(2.0)))
        p = 2.0 * (1.0 - cdf)
        return max(0.0, min(1.0, p))
    except Exception:
        return 1.0


def _logrank_pure(time_high, event_high, time_low, event_low):
    """纯 Python log-rank 检验 + O/E 比 HR。

    返回 (p_value, hr, hr_ci_low, hr_ci_high)。
    χ² = (O1 - E1)^2 / V；HR = (O1/E1) / (O2/E2)；log(HR) SE = sqrt(1/V)。
    """
    all_times = sorted(set(time_high) | set(time_low))
    o1 = 0  # high 组观察事件数
    e1 = 0.0  # high 组期望事件数
    v = 0.0  # 方差
    total_d = 0  # 总事件数
    o2 = 0  # low 组观察事件数
    for t in all_times:
        n1 = sum(1 for x in time_high if x >= t)
        n2 = sum(1 for x in time_low if x >= t)
        n = n1 + n2
        if n == 0:
            continue
        d1 = sum(1 for x, e in zip(time_high, event_high) if x == t and e == 1)
        d2 = sum(1 for x, e in zip(time_low, event_low) if x == t and e == 1)
        d = d1 + d2
        if d == 0:
            continue
        o1 += d1
        o2 += d2
        total_d += d
        e1 += n1 * d / n
        if n > 1:
            v += (n1 * n2 * d * (n - d)) / (n * n * (n - 1))

    if v <= 0:
        return 1.0, 1.0, 1.0, 1.0
    chi2 = (o1 - e1) ** 2 / v
    # p 值：优先 scipy，否则正态近似
    try:
        from scipy.stats import chi2 as chi2_dist
        p = float(chi2_dist.sf(chi2, df=1))
    except Exception:
        p = _normal_sf_two_sided(math.sqrt(chi2))

    e2 = total_d - e1
    if e1 <= 0 or e2 <= 0 or o1 <= 0 or o2 <= 0:
        hr = 1.0
        ci_low, ci_high = 1.0, 1.0
    else:
        hr = (o1 / e1) / (o2 / e2)
        se = math.sqrt(1.0 / v)
        try:
            ci_low = hr * math.exp(-1.96 * se)
            ci_high = hr * math.exp(1.96 * se)
        except OverflowError:
            ci_low, ci_high = 0.0, float("inf")
    return p, hr, ci_low, ci_high


def _survival_stats(time_high, event_high, time_low, event_low):
    """返回 (log_rank_p, hr, hr_ci_low, hr_ci_high)。优先 lifelines，降级纯 Python。"""
    try:
        from lifelines import CoxPHFitter
        from lifelines.statistics import logrank_test
        import pandas as pd
        result = logrank_test(time_high, time_low,
                              event_observed_A=event_high,
                              event_observed_B=event_low)
        p = float(result.p_value)
        df = pd.DataFrame({
            "time": list(time_high) + list(time_low),
            "event": list(event_high) + list(event_low),
            "group": [1] * len(time_high) + [0] * len(time_low),
        })
        hr, ci_low, ci_high = _logrank_pure(time_high, event_high,
                                            time_low, event_low)[1:]
        try:
            cph = CoxPHFitter()
            cph.fit(df, duration_col="time", event_col="event")
            s = cph.summary.loc["group"]
            hr = float(s["exp(coef)"])
            ci_low = float(s["exp(coef) lower 95%"])
            ci_high = float(s["exp(coef) upper 95%"])
        except Exception as e:
            log_stderr(f"Cox 拟合失败，HR 用 O/E 比: {e}")
        return p, hr, ci_low, ci_high
    except Exception as e:
        log_stderr(f"lifelines 不可用，降级纯 Python KM + log-rank: {e}")
        return _logrank_pure(time_high, event_high, time_low, event_low)


# ===== 结果构造 =====

def _insufficient_result(gene, cohort, task_id, reason):
    """数据不足时的降级结果（符合 survival_result.schema.json）。"""
    return {
        "task_id": task_id,
        "analysis_type": "survival_analysis",
        "gene": gene,
        "cohort": cohort,
        "groups": {
            "high_expression": {"n": 0, "events": 0,
                                "median_survival_months": 0.0},
            "low_expression": {"n": 0, "events": 0,
                               "median_survival_months": 0.0},
        },
        "log_rank_p": 1.0,
        "hr": 1.0,
        "hr_ci_95": [1.0, 1.0],
        "significance": "insufficient_data",
        "chart_data": {"km_curves": []},
        "summary": f"{gene}（{cohort}）生存分析数据不足：{reason}；"
                   f"可通过 --input 提供 TCGA 表达+临床数据",
        "created_at": utc_now(),
    }


def run_survival_analysis(gene, cohort, input_path, max_samples, task_id):
    """执行生存分析，返回符合 survival_result.schema.json 的 dict。"""
    expression = None
    clinical = None
    if input_path:
        expression, clinical = _load_expression_clinical(input_path)
        log_stderr(f"从 --input 加载表达 {len(expression) if expression else 0} 样本，"
                   f"临床 {len(clinical) if clinical else 0} 条")
    else:
        try:
            clinical = _fetch_gdc_clinical(cohort, max_samples)
            log_stderr(f"GDC {cohort} 临床数据 {len(clinical)} 条")
        except Exception as e:
            log_stderr(f"GDC 临床数据获取失败: {e}")
            clinical = []
        samples = [c["sample"] for c in clinical]
        expression = _fetch_gdc_expression(gene, cohort, samples, max_samples)

    if not expression or not clinical:
        reason = ("表达数据缺失（GDC 不提供轻量 per-gene 表达端点）"
                  if not input_path else "--input 中表达/临床数据缺失")
        return _insufficient_result(gene, cohort, task_id, reason)

    # 对齐样本：expression[sample] 与 clinical[sample] 取交集
    aligned = []
    for c in clinical:
        s = c.get("sample")
        if not s or s not in expression:
            continue
        val = expression.get(s)
        try:
            val = float(val)
        except (TypeError, ValueError):
            continue
        time = c.get("time_months", c.get("time"))
        try:
            time = float(time)
        except (TypeError, ValueError):
            continue
        if time <= 0:
            continue
        aligned.append({"sample": s, "value": val, "time": time,
                        "event": int(c.get("event", 0))})

    if len(aligned) < 10:
        return _insufficient_result(gene, cohort, task_id,
                                    f"对齐后样本数过少（{len(aligned)}）")

    # 按表达中位数分高/低两组
    values = sorted(a["value"] for a in aligned)
    median = values[len(values) // 2]
    high = [a for a in aligned if a["value"] > median]
    low = [a for a in aligned if a["value"] <= median]
    if not high or not low:
        return _insufficient_result(gene, cohort, task_id, "中位数分组失败")

    time_high = [a["time"] for a in high]
    event_high = [a["event"] for a in high]
    time_low = [a["time"] for a in low]
    event_low = [a["event"] for a in low]

    km_high = _km_estimate(time_high, event_high)
    km_low = _km_estimate(time_low, event_low)
    med_high = _median_survival(km_high)
    med_low = _median_survival(km_low)

    p, hr, ci_low, ci_high = _survival_stats(time_high, event_high,
                                             time_low, event_low)
    sig = "significant" if p < 0.05 else "not_significant"

    km_curves = _merge_km_curves(km_high, km_low)
    n_high, ev_high = len(high), sum(event_high)
    n_low, ev_low = len(low), sum(event_low)

    summary = (f"{gene} 高表达组（n={n_high}，事件 {ev_high}）中位生存 "
               f"{med_high:.1f} 个月，低表达组（n={n_low}，事件 {ev_low}）"
               f"{med_low:.1f} 个月，log-rank p={p:.4g}，"
               f"HR={hr:.2f}（{ci_low:.2f}-{ci_high:.2f}），"
               f"{'显著' if sig == 'significant' else '不显著'}")

    return {
        "task_id": task_id,
        "analysis_type": "survival_analysis",
        "gene": gene,
        "cohort": cohort,
        "groups": {
            "high_expression": {"n": n_high, "events": ev_high,
                                "median_survival_months": round(med_high, 4)},
            "low_expression": {"n": n_low, "events": ev_low,
                               "median_survival_months": round(med_low, 4)},
        },
        "log_rank_p": round(p, 6),
        "hr": round(hr, 4),
        "hr_ci_95": [round(ci_low, 4), round(ci_high, 4)],
        "significance": sig,
        "chart_data": {"km_curves": km_curves},
        "summary": summary,
        "created_at": utc_now(),
    }


def main():
    parser = setup_cli("survival_analysis", "生存分析（Kaplan-Meier + log-rank）")
    parser.add_argument("--gene", required=True, help="要分析的基因 symbol")
    parser.add_argument("--cohort", default="TCGA-PAAD",
                        help="TCGA 队列名（默认 TCGA-PAAD 胰腺癌）")
    parser.add_argument("--max-samples", type=int, default=200,
                        help="GDC 检索最大样本数（默认 200，避免超时）")
    args = parser.parse_args()
    try:
        result = run_survival_analysis(args.gene, args.cohort, args.input,
                                       args.max_samples, args.task_id)
        save_result(result, args.out)
        log_stderr(f"生存分析结果已写入 {args.out}")
    except Exception as e:
        save_error(f"生存分析失败: {e}", args.out)
        sys.exit(1)


if __name__ == "__main__":
    main()
