"""通过 API 提交 agent 任务并轮询状态，遇到 max_turns 自动 continue。

用法:
    python scripts/test_agent_task.py "课题文本" [--databases pubmed,geo,gdc]
    python scripts/test_agent_task.py "课题1" "课题2"  # 多课题串行
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

API_BASE = "http://127.0.0.1:8000/api/v1"
ALL_DATABASES = ["pubmed", "geo", "gdc", "pdb", "pubchem", "reactome", "xena"]

# 轮询间隔（秒）
POLL_INTERVAL = 5
# 单任务最大等待时间（秒）
MAX_WAIT = 600
# max_turns 自动 continue 的最大次数
MAX_AUTO_CONTINUE = 3


def api_call(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        print(f"  [API ERROR] {method} {path} -> {exc.code}: {error_body[:300]}")
        raise


def submit_task(topic: str, databases: list[str]) -> str:
    """提交 agent 任务，返回 task_id。"""
    result = api_call("POST", "/tasks", {
        "request_id": f"req_{uuid.uuid4().hex[:16]}",
        "input": topic,
        "databases": databases,
        "mode": "agent",
    })
    task_id = result["task_id"]
    print(f"  [SUBMIT] task_id={task_id}")
    return task_id


def get_task_status(task_id: str) -> dict[str, Any]:
    return api_call("GET", f"/tasks/{task_id}")


def get_events(task_id: str) -> list[dict]:
    result = api_call("GET", f"/tasks/{task_id}/events?limit=500")
    return result.get("events", [])


def get_pending_input(task_snapshot: dict, events: list[dict] | None = None) -> dict | None:
    """从 task snapshot + events 中提取 pending user input 信息。

    TaskSnapshot 中没有 pending_user_input 字段，需要从 events 流中
    找到最新的 ``user_input_required`` 事件来提取 request_id / prompt_kind。
    run_id 从 task_snapshot.task.active_run_id 获取。
    """
    task = task_snapshot.get("task", task_snapshot)
    run_id = task.get("active_run_id", "")

    if not events:
        return None

    # 反向查找最新的 user_input_required 事件
    for event in reversed(events):
        payload = event.get("payload", {})
        if payload.get("type") == "user_input_required":
            request_id = payload.get("request_id", "")
            prompt_kind = payload.get("prompt_kind", "")
            return {
                "run_id": run_id,
                "request_id": request_id,
                "prompt_kind": prompt_kind,
            }
    return None


def resume_task(task_id: str, run_id: str, request_id: str, decision: str = "approve") -> bool:
    """发送 resume 请求（max_turns 或 plan_confirmation 后继续）。"""
    try:
        api_call("POST", f"/tasks/{task_id}/runs/{run_id}/resume", {
            "request_id": request_id,
            "decision": decision,
        })
        print(f"  [RESUME] {decision} (run={run_id[:20]}, req={request_id[:20]})")
        return True
    except Exception as exc:
        print(f"  [RESUME FAILED] {exc}")
        return False


def continue_task(task_id: str, task_snapshot: dict, events: list[dict] | None = None) -> bool:
    """处理 awaiting_user_input：max_turns/plan_confirmation 自动 approve。"""
    if events is None:
        events = get_events(task_id)
    pending = get_pending_input(task_snapshot, events)
    if not pending:
        print(f"  [CONTINUE] no pending user_input_required event found, skipping")
        return False

    run_id = pending.get("run_id", "")
    request_id = pending.get("request_id", "")
    prompt_kind = pending.get("prompt_kind", "")

    if not run_id or not request_id:
        print(f"  [CONTINUE] missing run_id or request_id in pending: {pending}")
        return False

    print(f"  [CONTINUE] prompt_kind={prompt_kind} -> approve")
    return resume_task(task_id, run_id, request_id, "approve")


def summarize_events(events: list[dict]) -> dict:
    """统计事件流中的关键信息。"""
    tool_calls: list[str] = []
    stage_progress_count = 0
    errors: list[str] = []
    has_run_failed = False
    has_task_completed = False

    for event in events:
        payload = event.get("payload", {})
        etype = payload.get("type", "")

        if etype == "tool_started":
            tool_calls.append(payload.get("tool_name", "?"))
        elif etype == "stage_progress":
            stage_progress_count += 1
        elif etype == "run_failed":
            has_run_failed = True
            errors.append(payload.get("error", "")[:200])
        elif etype == "task_completed":
            has_task_completed = True

    return {
        "tool_calls": tool_calls,
        "stage_progress_count": stage_progress_count,
        "errors": errors,
        "has_run_failed": has_run_failed,
        "has_task_completed": has_task_completed,
    }


def run_test_topic(topic: str, databases: list[str]) -> dict:
    """运行单个测试课题，返回结果摘要。"""
    print(f"\n{'='*60}")
    print(f"课题: {topic}")
    print(f"数据库: {databases}")
    print(f"{'='*60}")

    start_time = time.time()
    task_id = submit_task(topic, databases)
    continue_count = 0
    final_status = "unknown"

    while time.time() - start_time < MAX_WAIT:
        time.sleep(POLL_INTERVAL)
        try:
            task = get_task_status(task_id)
        except Exception:
            continue

        task_data = task.get("task", task)
        status = task_data.get("status", "?")
        final_status = status
        elapsed = int(time.time() - start_time)

        if status == "awaiting_user_input":
            # 获取 pending user input 信息（需从 events 提取）
            try:
                events = get_events(task_id)
            except Exception:
                events = []
            pending = get_pending_input(task, events)
            prompt_kind = pending.get("prompt_kind", "") if pending else ""

            if prompt_kind == "max_turns_reached" and continue_count < MAX_AUTO_CONTINUE:
                print(f"  [{elapsed}s] max_turns_reached -> auto continue ({continue_count + 1}/{MAX_AUTO_CONTINUE})")
                continue_task(task_id, task, events)
                continue_count += 1
                continue
            elif prompt_kind == "plan_confirmation":
                print(f"  [{elapsed}s] plan_confirmation -> auto approve")
                continue_task(task_id, task, events)
                continue
            elif prompt_kind == "max_turns_reached" and continue_count >= MAX_AUTO_CONTINUE:
                print(f"  [{elapsed}s] max_turns_reached but continue limit reached ({continue_count}/{MAX_AUTO_CONTINUE})")
                break
            elif not prompt_kind:
                print(f"  [{elapsed}s] awaiting_user_input but no pending event found, retrying")
                continue
            else:
                print(f"  [{elapsed}s] awaiting_user_input (prompt_kind={prompt_kind}) -> auto approve")
                continue_task(task_id, task, events)
                continue

        elif status in ("completed", "failed", "cancelled", "interrupted"):
            print(f"  [{elapsed}s] FINAL STATUS: {status}")
            break
        else:
            active_run = task_data.get("active_run_id", "")
            print(f"  [{elapsed}s] status={status} run={active_run[:20] if active_run else 'none'}")

    # 获取事件统计
    events = get_events(task_id)
    summary = summarize_events(events)

    result = {
        "topic": topic,
        "task_id": task_id,
        "final_status": final_status,
        "elapsed_seconds": int(time.time() - start_time),
        "tool_calls": summary["tool_calls"],
        "stage_progress_count": summary["stage_progress_count"],
        "errors": summary["errors"],
        "continue_count": continue_count,
    }

    print(f"\n  --- 结果 ---")
    print(f"  状态: {final_status}")
    print(f"  耗时: {result['elapsed_seconds']}s")
    print(f"  工具调用: {result['tool_calls']}")
    print(f"  stage_progress 事件数: {result['stage_progress_count']}")
    print(f"  continue 次数: {continue_count}")
    if result["errors"]:
        print(f"  错误: {result['errors']}")

    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="通过 API 测试 agent 任务")
    parser.add_argument("topics", nargs="+", help="研究课题文本（可多个）")
    parser.add_argument(
        "--databases",
        default=",".join(ALL_DATABASES),
        help=f"逗号分隔的数据库列表（默认全部: {','.join(ALL_DATABASES)}）",
    )
    args = parser.parse_args()

    databases = [d.strip() for d in args.databases.split(",") if d.strip()]
    print(f"数据库: {databases}")

    results: list[dict] = []
    for topic in args.topics:
        result = run_test_topic(topic, databases)
        results.append(result)

    # 汇总
    print(f"\n\n{'='*60}")
    print("汇总")
    print(f"{'='*60}")
    for r in results:
        status_icon = "✓" if r["final_status"] == "completed" else "✗"
        print(f"  {status_icon} [{r['final_status']}] {r['topic'][:40]}... ({r['elapsed_seconds']}s, {len(r['tool_calls'])} tools)")

    succeeded = sum(1 for r in results if r["final_status"] == "completed")
    print(f"\n成功: {succeeded}/{len(results)}")

    return 0 if succeeded == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
