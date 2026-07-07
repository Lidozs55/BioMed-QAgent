"""reflection_loop.py — 达尔文反思循环控制器。

读取 stage_evaluator.py 输出的 EvaluationResult，决定是否触发再检索/再分析。
若 passed=false，根据 suggestions 调用 keyword_expander.py 生成新查询，
并维护跨迭代的 ReflectionLog。

提供三个领域函数（对应原 CLI 的 record/decide/finalize 子命令）：
  - record:   记录一次评估-行动，追加到 ReflectionLog
  - decide:   读取最新评估，输出下一步行动指令（供 Agent 执行）
  - finalize: 任务结束，生成最终 ReflectionLog 摘要

单 stage 最多迭代 MAX_ITERATIONS=3 轮，超过即标记 max_iterations_reached。

模块导入示例：
    from .reflection_loop import record, decide, finalize
    from ._base import load_evaluation

    record(evaluation_path="eval_clean.json", action="expand_search",
           reflection_log_path="reflection.json", task_id="T1",
           new_queries=["TP53 OR p53"])
    decision = decide(evaluation_path="eval_clean.json",
                      reflection_log_path="reflection.json")
"""
from __future__ import annotations

import logging

from ._base import (
    MAX_ITERATIONS,
    load_evaluation,
    load_reflection,
    save_reflection,
    utc_now,
)

logger = logging.getLogger(__name__)


def _new_reflection(task_id):
    """创建新的反思日志。"""
    return {
        "task_id": task_id,
        "iterations": [],
        "total_iterations": 0,
        "final_status": "in_progress",
        "convergence_score": 0.0,
        "lessons_learned": [],
        "summary": "",
        "created_at": utc_now(),
    }


def _append_iteration(reflection, iteration_entry):
    """追加一次迭代记录到反思日志。"""
    reflection["iterations"].append(iteration_entry)
    reflection["total_iterations"] = len(reflection["iterations"])
    return reflection


def _decide_action(evaluation, reflection):
    """基于评估结果与历史迭代决定下一步行动。"""
    if evaluation.get("passed", False):
        return {
            "action": "accept",
            "reason": "Stage Gate 通过，无需进一步行动",
            "should_iterate": False,
        }

    current_iter = evaluation.get("iteration", 1)
    if current_iter >= MAX_ITERATIONS:
        return {
            "action": "accept",
            "reason": f"已达最大迭代次数 {MAX_ITERATIONS}，强制接受当前结果",
            "should_iterate": False,
            "force_accept": True,
        }

    suggestions = evaluation.get("suggestions", [])
    if not suggestions:
        return {
            "action": "accept",
            "reason": "无 suggestions，接受当前结果",
            "should_iterate": False,
        }

    # 优先级：request_user_input > add_source > expand_search > deepen_analysis > refine_keywords
    priority = ["request_user_input", "add_source", "expand_search",
                "deepen_analysis", "refine_keywords"]
    for action_type in priority:
        for s in suggestions:
            if s.get("action") == action_type:
                return {
                    "action": action_type,
                    "detail": s,
                    "should_iterate": True,
                    "next_iteration": current_iter + 1,
                    "reason": s.get("reason", ""),
                }

    return {
        "action": "accept",
        "reason": "无匹配的 suggestion action",
        "should_iterate": False,
    }


def _compute_convergence_score(reflection):
    """计算收敛分：通过率 × 改善度。"""
    if not reflection["iterations"]:
        return 0.0
    passed_count = sum(1 for it in reflection["iterations"]
                       if it.get("evaluation", {}).get("passed", False))
    pass_rate = passed_count / len(reflection["iterations"])
    # 改善度：最后一次覆盖率 vs 第一次覆盖率
    first = reflection["iterations"][0].get("evaluation", {})
    last = reflection["iterations"][-1].get("evaluation", {})
    first_cov = first.get("coverage", 0.0)
    last_cov = last.get("coverage", 0.0)
    improvement = max(0.0, last_cov - first_cov)
    return round(min(1.0, pass_rate * 0.7 + improvement * 0.3), 4)


def _generate_lessons(reflection):
    """从迭代历史中提取经验教训。"""
    lessons = []
    if not reflection["iterations"]:
        return lessons

    # 教训 1：哪些数据源最常被建议补充
    add_source_count = {}
    for it in reflection["iterations"]:
        for s in it.get("evaluation", {}).get("suggestions", []):
            if s.get("action") == "add_source":
                src = s.get("source", "unknown")
                add_source_count[src] = add_source_count.get(src, 0) + 1
    if add_source_count:
        top_src = max(add_source_count, key=add_source_count.get)
        lessons.append(f"数据源 '{top_src}' 经常被建议补充，下次任务可在 search 阶段提前加入")

    # 教训 2：哪些实体类型最容易缺失
    gap_entity_types = {}
    for it in reflection["iterations"]:
        for g in it.get("evaluation", {}).get("gaps", []):
            typ = g.get("entity_type", "unknown")
            gap_entity_types[typ] = gap_entity_types.get(typ, 0) + 1
    if gap_entity_types:
        top_typ = max(gap_entity_types, key=gap_entity_types.get)
        lessons.append(f"实体类型 '{top_typ}' 最易缺失，下次任务应优先扩展该类型实体")

    # 教训 3：迭代次数
    total = reflection["total_iterations"]
    if total > 1:
        lessons.append(f"本任务共迭代 {total} 轮才收敛，建议下次任务初始即用更广查询")
    elif total == 1:
        lessons.append("本任务一次通过 Stage Gate，初始查询已足够")

    return lessons


def record(evaluation_path, action, reflection_log_path, task_id="default",
           new_queries=None, new_sources=None, new_analyses=None):
    """记录一次评估-行动，追加到 ReflectionLog。

    Args:
        evaluation_path: EvaluationResult JSON 文件路径
        action: 本次采取的行动（expand_search/add_source/deepen_analysis/
                refine_keywords/request_user_input/accept）
        reflection_log_path: ReflectionLog JSON 文件路径
        task_id: 任务 ID
        new_queries: 新增查询列表（list[str]）
        new_sources: 新增数据源列表（list[str]）
        new_analyses: 新增分析列表（list[str]）

    Returns:
        dict: 本次迭代条目，并附带 total_iterations
    """
    evaluation = load_evaluation(evaluation_path)
    if not evaluation:
        raise ValueError(f"无法读取评估结果: {evaluation_path}")

    reflection = load_reflection(reflection_log_path) or _new_reflection(task_id)

    new_queries = new_queries or []
    new_sources = new_sources or []
    new_analyses = new_analyses or []

    entry = {
        "iteration": evaluation.get("iteration", 1),
        "stage": evaluation.get("stage", "unknown"),
        "evaluation": {
            "passed": evaluation.get("passed", False),
            "coverage": evaluation.get("metrics", {}).get("coverage", 0.0),
            "avg_confidence": evaluation.get("metrics", {}).get("avg_confidence", 0.0),
            "conflict_rate": evaluation.get("metrics", {}).get("conflict_rate", 0.0),
            "source_diversity": evaluation.get("metrics", {}).get("source_diversity", 0),
        },
        "action_taken": action,
        "new_queries": new_queries,
        "new_sources": new_sources,
        "new_analyses": new_analyses,
        "timestamp": utc_now(),
    }
    reflection = _append_iteration(reflection, entry)
    save_reflection(reflection, reflection_log_path)
    logger.warning(
        "记录迭代 #%s: action=%s total_iterations=%s",
        entry["iteration"], action, reflection["total_iterations"]
    )
    return {
        "total_iterations": reflection["total_iterations"],
        "action": action,
        "entry": entry,
    }


def decide(evaluation_path, reflection_log_path, task_id="default"):
    """基于评估结果决定下一步行动。

    Args:
        evaluation_path: EvaluationResult JSON 文件路径
        reflection_log_path: ReflectionLog JSON 文件路径
        task_id: 任务 ID

    Returns:
        dict: 决策结果，包含 action/should_iterate/reason 等字段
    """
    evaluation = load_evaluation(evaluation_path)
    if not evaluation:
        raise ValueError(f"无法读取评估结果: {evaluation_path}")

    reflection = load_reflection(reflection_log_path) or _new_reflection(task_id)
    decision = _decide_action(evaluation, reflection)
    logger.warning(
        "决策: action=%s should_iterate=%s",
        decision["action"], decision["should_iterate"]
    )
    return decision


def finalize(reflection_log_path, output_path, task_id="default"):
    """任务结束，生成最终反思日志。

    Args:
        reflection_log_path: 原始 ReflectionLog JSON 文件路径
        output_path: 最终反思日志输出路径
        task_id: 任务 ID

    Returns:
        dict: 最终反思日志摘要
    """
    reflection = load_reflection(reflection_log_path)
    if not reflection:
        reflection = _new_reflection(task_id)

    # 判定最终状态
    if reflection["total_iterations"] == 0:
        reflection["final_status"] = "converged"
    else:
        last_passed = reflection["iterations"][-1].get("evaluation", {}).get("passed", False)
        if last_passed:
            reflection["final_status"] = "converged"
        elif reflection["total_iterations"] >= MAX_ITERATIONS:
            reflection["final_status"] = "max_iterations_reached"
        else:
            reflection["final_status"] = "converged"  # 用户主动结束

    reflection["convergence_score"] = _compute_convergence_score(reflection)
    reflection["lessons_learned"] = _generate_lessons(reflection)
    reflection["summary"] = (
        f"任务 {task_id} 完成：{reflection['total_iterations']} 轮迭代，"
        f"最终状态 {reflection['final_status']}，收敛分 {reflection['convergence_score']:.2f}"
    )

    save_reflection(reflection, output_path)
    logger.warning(
        "任务结束: %s score=%s",
        reflection["final_status"], reflection["convergence_score"]
    )
    return {
        "final_status": reflection["final_status"],
        "convergence_score": reflection["convergence_score"],
        "total_iterations": reflection["total_iterations"],
        "lessons_count": len(reflection["lessons_learned"]),
        "summary": reflection["summary"],
    }
