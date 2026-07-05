"""stage_evaluator.py — 达尔文 Stage Gate 评估器。

每个 stage 完成后调用，评估当前数据的覆盖率/置信度/冲突率/来源多样性，
识别数据缺口并给出下一步行动建议。若任一指标未达标，输出 passed=false
驱动 reflection_loop.py 触发反思循环。

评估指标：
  - coverage: 用户查询中的关键实体已获得数据的比例（基于 entity_extract）
  - avg_confidence: 所有记录的平均 extraction_confidence
  - conflict_rate: quality_flags 含 'conflict' 或 'needs_review' 的记录占比
  - source_diversity: 不同 source_name 的数量
  - entity_coverage: 按 gene/compound/disease/pathway 分组的覆盖率明细

阈值：见 optimization/_base.py DEFAULT_THRESHOLDS，可被 --thresholds 覆盖

用法：
    python scripts/optimization/stage_evaluator.py \\
        --records cleaned.json \\
        --stage clean --iteration 1 --task-id T1 \\
        --entities 'TP53,AKT1,quercetin,pancreatic_cancer' \\
        --out eval_clean.json

输出：{"status":"ok","evaluation":{...},"passed":bool}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_HERE = Path(__file__).parent.resolve()
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from _base import (
    DEFAULT_THRESHOLDS,
    emit_error_stdout,
    emit_ok_stdout,
    load_records,
    log_stderr,
    make_evaluation,
    save_evaluation,
    setup_cli,
    utc_now,
)

# ===== 关键实体类型识别规则 =====
# 字段名 → 实体类型 映射，用于从 records 中提取已覆盖的实体
ENTITY_FIELD_MAP = {
    "gene": ["gene_symbol", "gene", "symbol", "target_gene"],
    "compound": ["compound_name", "mol_name", "drug_name", "compound"],
    "disease": ["disease", "cancer_type", "indication"],
    "pathway": ["pathway_id", "pathway", "kegg_id"],
    "structure": ["pdb_id", "structure_id"],
    "clinical_trial": ["nct_id", "trial_id"],
}


def _parse_entities(entities_str):
    """解析 --entities 参数为实体集合。

    输入格式：逗号分隔的实体列表（不区分类型，全部当作 gene/compound/disease 候选）。
    也可用 'gene:TP53,compound:quercetin' 显式标注类型。
    """
    if not entities_str:
        return {}
    result = {"gene": set(), "compound": set(), "disease": set(),
              "pathway": set(), "structure": set(), "clinical_trial": set()}
    for part in entities_str.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            typ, val = part.split(":", 1)
            typ = typ.strip().lower()
            val = val.strip()
            if typ in result:
                result[typ].add(val)
        else:
            # 无类型标注时，按命名特征自动归类
            val = part
            up = val.upper()
            if up.startswith("GSE") or up.startswith("NCT"):
                result["clinical_trial"].add(val)
            elif up.startswith("PDB") or (len(val) == 4 and val[0].isdigit()):
                result["structure"].add(val)
            elif up.startswith("HSA") or up.startswith("PATH:"):
                result["pathway"].add(val)
            elif val[0].isupper() and val.isalpha() and len(val) <= 6:
                # 大写短串大概率是 gene symbol
                result["gene"].add(val)
            else:
                # 其余按 gene + compound 双重候选
                result["gene"].add(val)
                result["compound"].add(val)
    return {k: v for k, v in result.items() if v}


def _extract_covered_entities(records):
    """从 DataRecord 列表中提取已被覆盖的实体（按类型分组）。"""
    covered = {"gene": set(), "compound": set(), "disease": set(),
              "pathway": set(), "structure": set(), "clinical_trial": set()}
    for r in records:
        if not isinstance(r, dict):
            continue
        fields = r.get("fields", {}) if isinstance(r.get("fields"), dict) else {}
        for entity_type, field_names in ENTITY_FIELD_MAP.items():
            for fn in field_names:
                val = fields.get(fn)
                if val:
                    if isinstance(val, list):
                        for v in val:
                            covered[entity_type].add(str(v))
                    else:
                        covered[entity_type].add(str(val))
    return covered


def _compute_metrics(records, expected_entities):
    """计算评估指标。"""
    if not records:
        return {
            "coverage": 0.0,
            "avg_confidence": 0.0,
            "conflict_rate": 0.0,
            "source_diversity": 0,
            "record_count": 0,
            "entity_coverage": {},
        }, []

    # 来源多样性
    sources = set()
    for r in records:
        src = r.get("source_ref", {}).get("source_name") if isinstance(r, dict) else None
        if src:
            sources.add(src)

    # 平均置信度
    confidences = [r.get("extraction_confidence", 0.0) for r in records
                   if isinstance(r, dict) and isinstance(r.get("extraction_confidence"), (int, float))]
    avg_conf = sum(confidences) / len(confidences) if confidences else 0.0

    # 冲突率
    conflict_count = 0
    for r in records:
        flags = r.get("quality_flags", []) if isinstance(r, dict) else []
        if any(f in flags for f in ("conflict", "needs_review", "low_confidence")):
            conflict_count += 1
    conflict_rate = conflict_count / len(records) if records else 0.0

    # 实体覆盖率（大小写不敏感匹配：用户输入与记录存储的大小写可能不一致，
    # 例如 field_aligner 会将 compound_name 转为 Title Case "Quercetin"，
    # 而用户输入可能是 "quercetin"。统一转 lower 比较，保留原始大小写用于展示。）
    covered = _extract_covered_entities(records)
    entity_coverage = {}
    gaps = []
    total_expected = 0
    total_covered = 0
    for entity_type, expected_set in expected_entities.items():
        if not expected_set:
            continue
        covered_set = covered.get(entity_type, set())
        # 统一小写后做集合运算
        covered_lower = {str(v).lower() for v in covered_set}
        expected_lower = {str(v).lower() for v in expected_set}
        # 原始值反查表（lower → 原始大小写），用于展示与 gaps
        expected_lower_to_orig = {str(v).lower(): v for v in expected_set}
        covered_expected_lower = expected_lower & covered_lower
        missing_lower = expected_lower - covered_lower
        # 反查回原始大小写，保证展示与用户输入一致
        covered_display = sorted([expected_lower_to_orig[l] for l in covered_expected_lower])
        missing_display = sorted([expected_lower_to_orig[l] for l in missing_lower])
        entity_coverage[entity_type] = {
            "covered": covered_display,
            "missing": missing_display,
        }
        total_expected += len(expected_set)
        total_covered += len(covered_expected_lower)
        for m in missing_display:
            reason_map = {
                "gene": "no_gene_data",
                "compound": "no_compound_data",
                "disease": "no_disease_annotation",
                "pathway": "no_pathway_annotation",
                "structure": "no_pdb_structure",
                "clinical_trial": "no_clinical_trial",
            }
            gaps.append({
                "entity_type": entity_type,
                "entity_id": m,
                "reason": reason_map.get(entity_type, "missing"),
            })

    coverage = (total_covered / total_expected) if total_expected > 0 else 1.0

    metrics = {
        "coverage": round(coverage, 4),
        "avg_confidence": round(avg_conf, 4),
        "conflict_rate": round(conflict_rate, 4),
        "source_diversity": len(sources),
        "record_count": len(records),
        "entity_coverage": entity_coverage,
    }
    return metrics, gaps


def _generate_suggestions(stage, metrics, gaps, expected_entities):
    """基于缺口与指标生成下一步行动建议（驱动反思循环）。"""
    suggestions = []

    # 1. 覆盖率不足 → 扩展检索
    if metrics["coverage"] < 0.6:
        missing_genes = []
        missing_compounds = []
        for g in gaps:
            if g["entity_type"] == "gene":
                missing_genes.append(g["entity_id"])
            elif g["entity_type"] == "compound":
                missing_compounds.append(g["entity_id"])
        if missing_genes:
            suggestions.append({
                "action": "expand_search",
                "query": " OR ".join(missing_genes[:5]),
                "reason": f"以下基因未覆盖: {', '.join(missing_genes[:5])}",
            })
        if missing_compounds:
            suggestions.append({
                "action": "expand_search",
                "query": " OR ".join(missing_compounds[:5]),
                "reason": f"以下化合物未覆盖: {', '.join(missing_compounds[:5])}",
            })

    # 2. 来源多样性不足 → 增加数据源
    if metrics["source_diversity"] < 2:
        suggestions.append({
            "action": "add_source",
            "source": "clinicaltrials" if stage == "search" else "tcga",
            "reason": f"来源多样性仅 {metrics['source_diversity']}，建议补充数据源",
        })

    # 3. 临床试验缺口
    if any(g["entity_type"] == "clinical_trial" for g in gaps):
        suggestions.append({
            "action": "add_source",
            "source": "clinicaltrials",
            "reason": "用户关注临床试验但未检索到相关试验",
        })

    # 4. 结构缺口
    structure_gaps = [g for g in gaps if g["entity_type"] == "structure"]
    if structure_gaps:
        suggestions.append({
            "action": "add_source",
            "source": "pdb",
            "reason": f"以下蛋白结构缺失: {', '.join(g['entity_id'] for g in structure_gaps[:3])}",
        })

    # 5. 分析阶段：基于已有 hub gene 建议深度分析
    if stage == "analyze":
        if metrics["coverage"] >= 0.7:
            suggestions.append({
                "action": "deepen_analysis",
                "analysis": "hub_gene",
                "reason": "数据覆盖率已较高，可识别 hub gene 并反查上游调控因子",
            })
            suggestions.append({
                "action": "deepen_analysis",
                "analysis": "survival",
                "reason": "建议对 hub gene 做生存分析验证临床意义",
            })

    # 6. 冲突率高 → 请求用户介入
    if metrics["conflict_rate"] > 0.3:
        suggestions.append({
            "action": "request_user_input",
            "reason": f"冲突率 {metrics['conflict_rate']:.2%} 过高，建议用户介入裁决",
        })

    return suggestions


def evaluate(records, stage, iteration, task_id, expected_entities,
             thresholds_override=None):
    """执行 Stage Gate 评估，返回 EvaluationResult dict。"""
    thresholds = thresholds_override or DEFAULT_THRESHOLDS.get(stage, DEFAULT_THRESHOLDS["search"])
    metrics, gaps = _compute_metrics(records, expected_entities)

    # 判定是否通过 Stage Gate
    passed = (
        metrics["coverage"] >= thresholds["min_coverage"]
        and metrics["avg_confidence"] >= thresholds["min_confidence"]
        and metrics["conflict_rate"] <= thresholds["max_conflict_rate"]
        and metrics["source_diversity"] >= thresholds["min_sources"]
    )

    suggestions = [] if passed else _generate_suggestions(stage, metrics, gaps, expected_entities)

    return make_evaluation(
        task_id=task_id,
        stage=stage,
        iteration=iteration,
        metrics=metrics,
        thresholds=thresholds,
        passed=passed,
        gaps=gaps,
        suggestions=suggestions,
    )


def main():
    parser = setup_cli("stage_evaluator", "达尔文 Stage Gate 评估器")
    parser.add_argument("--records", required=True,
                        help="DataRecord JSON 文件或目录")
    parser.add_argument("--stage", required=True,
                        choices=["search", "acquire", "parse", "clean", "analyze", "export"],
                        help="评估的流水线阶段")
    parser.add_argument("--iteration", type=int, default=1,
                        help="当前迭代轮次（默认 1）")
    parser.add_argument("--entities", default="",
                        help="用户查询中的关键实体，逗号分隔。"
                             "支持 'gene:TP53,compound:quercetin' 显式标注，"
                             "或 'TP53,quercetin,pancreatic_cancer' 自动归类")
    parser.add_argument("--thresholds", default=None,
                        help="阈值覆盖 JSON 文件路径；不指定则用 stage 默认阈值")
    args = parser.parse_args()

    try:
        records = load_records(args.records)
        log_stderr(f"加载 {len(records)} 条记录，stage={args.stage} iter={args.iteration}")

        expected = _parse_entities(args.entities)
        log_stderr(f"期望实体: { {k: len(v) for k, v in expected.items()} }")

        thresholds_override = None
        if args.thresholds:
            with open(args.thresholds, "r", encoding="utf-8") as f:
                thresholds_override = json.load(f)

        evaluation = evaluate(
            records=records,
            stage=args.stage,
            iteration=args.iteration,
            task_id=args.task_id,
            expected_entities=expected,
            thresholds_override=thresholds_override,
        )

        save_evaluation(evaluation, args.out)
        emit_ok_stdout({
            "status": "ok",
            "passed": evaluation["passed"],
            "coverage": evaluation["metrics"]["coverage"],
            "avg_confidence": evaluation["metrics"]["avg_confidence"],
            "suggestions_count": len(evaluation["suggestions"]),
        })
        log_stderr(f"评估完成: passed={evaluation['passed']} "
                    f"coverage={evaluation['metrics']['coverage']:.2%} "
                    f"suggestions={len(evaluation['suggestions'])}")
    except Exception as e:
        log_stderr(f"评估失败: {e}")
        emit_error_stdout(f"stage_evaluator 失败: {e}")


if __name__ == "__main__":
    main()
