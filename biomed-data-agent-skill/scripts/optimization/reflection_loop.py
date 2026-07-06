"""reflection_loop.py — 达尔文反思循环控制器。

读取 stage_evaluator.py 输出的 EvaluationResult，决定是否触发再检索/再分析。
若 passed=false，根据 suggestions 调用 keyword_expander.py 生成新查询，
并维护跨迭代的 ReflectionLog。

支持子命令：
  - record:  记录一次评估-行动，追加到 ReflectionLog
  - decide:  读取最新评估，输出下一步行动指令（供 Agent 执行）
  - finalize: 任务结束，生成最终 ReflectionLog 摘要

单 stage 最多迭代 MAX_ITERATIONS=3 轮，超过即标记 max_iterations_reached。

用法：
    # 记录一次评估
    python scripts/optimization/reflection_loop.py record \\
        --evaluation eval_clean.json --action expand_search \\
        --new-queries '["TP53 OR p53"]' \\
        --reflection-log reflection.json --task-id T1

    # 决定下一步
    python scripts/optimization/reflection_loop.py decide \\
        --evaluation eval_clean.json --reflection-log reflection.json

    # 任务结束
    python scripts/optimization/reflection_loop.py finalize \\
        --reflection-log reflection.json --task-id T1 --out final_reflection.json
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
    MAX_ITERATIONS,
    emit_error_stdout,
    emit_ok_stdout,
    load_evaluation,
    load_reflection,
    log_stderr,
    save_reflection,
    setup_cli,
    utc_now,
)


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


def cmd_record(args):
    """record 子命令：记录一次评估-行动。"""
    evaluation = load_evaluation(args.evaluation)
    if not evaluation:
        emit_error_stdout(f"无法读取评估结果: {args.evaluation}")
        return

    reflection = load_reflection(args.reflection_log) or _new_reflection(args.task_id)

    new_queries = json.loads(args.new_queries) if args.new_queries else []
    new_sources = json.loads(args.new_sources) if args.new_sources else []
    new_analyses = json.loads(args.new_analyses) if args.new_analyses else []

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
        "action_taken": args.action,
        "new_queries": new_queries,
        "new_sources": new_sources,
        "new_analyses": new_analyses,
        "timestamp": utc_now(),
    }
    reflection = _append_iteration(reflection, entry)
    save_reflection(reflection, args.reflection_log)
    emit_ok_stdout({
        "status": "ok",
        "total_iterations": reflection["total_iterations"],
        "action": args.action,
    })
    log_stderr(f"记录迭代 #{entry['iteration']}: action={args.action}")


def cmd_decide(args):
    """decide 子命令：基于评估结果决定下一步。"""
    evaluation = load_evaluation(args.evaluation)
    if not evaluation:
        emit_error_stdout(f"无法读取评估结果: {args.evaluation}")
        return

    reflection = load_reflection(args.reflection_log) or _new_reflection(args.task_id)
    decision = _decide_action(evaluation, reflection)
    emit_ok_stdout({
        "status": "ok",
        "decision": decision,
    })
    log_stderr(f"决策: action={decision['action']} should_iterate={decision['should_iterate']}")


def cmd_finalize(args):
    """finalize 子命令：任务结束，生成最终反思日志。"""
    reflection = load_reflection(args.reflection_log)
    if not reflection:
        reflection = _new_reflection(args.task_id)

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
        f"任务 {args.task_id} 完成：{reflection['total_iterations']} 轮迭代，"
        f"最终状态 {reflection['final_status']}，收敛分 {reflection['convergence_score']:.2f}"
    )

    save_reflection(reflection, args.out)
    emit_ok_stdout({
        "status": "ok",
        "final_status": reflection["final_status"],
        "convergence_score": reflection["convergence_score"],
        "total_iterations": reflection["total_iterations"],
        "lessons_count": len(reflection["lessons_learned"]),
    })
    log_stderr(f"任务结束: {reflection['final_status']} score={reflection['convergence_score']}")


def main():
    parser = argparse.ArgumentParser(prog="reflection_loop",
                                     description="达尔文反思循环控制器")
    sub = parser.add_subparsers(dest="cmd", required=True)

    # record
    p_rec = sub.add_parser("record", help="记录一次评估-行动")
    p_rec.add_argument("--evaluation", required=True, help="EvaluationResult JSON 文件")
    p_rec.add_argument("--action", required=True,
                       choices=["expand_search", "add_source", "deepen_analysis",
                                "refine_keywords", "request_user_input", "accept"])
    p_rec.add_argument("--new-queries", default="[]", help="新增查询 JSON 数组字符串")
    p_rec.add_argument("--new-sources", default="[]", help="新增数据源 JSON 数组字符串")
    p_rec.add_argument("--new-analyses", default="[]", help="新增分析 JSON 数组字符串")
    p_rec.add_argument("--reflection-log", required=True, help="ReflectionLog JSON 文件")
    p_rec.add_argument("--task-id", default="default")

    # decide
    p_dec = sub.add_parser("decide", help="决定下一步行动")
    p_dec.add_argument("--evaluation", required=True, help="EvaluationResult JSON 文件")
    p_dec.add_argument("--reflection-log", required=True, help="ReflectionLog JSON 文件")

    # finalize
    p_fin = sub.add_parser("finalize", help="任务结束生成最终反思日志")
    p_fin.add_argument("--reflection-log", required=True, help="ReflectionLog JSON 文件")
    p_fin.add_argument("--task-id", default="default")
    p_fin.add_argument("--out", required=True, help="最终反思日志输出路径")

    args = parser.parse_args()
    try:
        if args.cmd == "record":
            cmd_record(args)
        elif args.cmd == "decide":
            cmd_decide(args)
        elif args.cmd == "finalize":
            cmd_finalize(args)
    except Exception as e:
        log_stderr(f"反思循环失败: {e}")
        emit_error_stdout(f"reflection_loop 失败: {e}")


if __name__ == "__main__":
    main()
