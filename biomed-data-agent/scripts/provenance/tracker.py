"""数据溯源追踪器（赛题核心：来源可追溯性）。

有状态 CLI，三种操作：
  record : 记录新 ProvenanceNode，落盘 <node_id>.json
  link   : 把上游 node_id 加入下游节点 input_node_ids
  export : 加载全部节点 + records，反向追溯每条 record 的 root sources，
           输出符合 lineage_graph.schema.yaml 的 lineage.json

示例：
  python scripts/provenance/tracker.py record --task-id T1 --op search \
      --agent pubmed_client.py --params '{"query":"AKT1"}' --out nodes/
  python scripts/provenance/tracker.py link --node search-abc12345 --to parse-def67890 --out nodes/
  python scripts/provenance/tracker.py export --task-id T1 --nodes-dir nodes/ \
      --records results/cleaned.json --out lineage.json

输出：成功 {"status": "ok", ...}；失败 {"status": "error", "message": "..."}
"""
import argparse
import json
import os
import sys
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from _base import make_node, load_nodes, load_records, save_lineage, validate_dag  # noqa: E402


def _emit_ok(payload):
    sys.stdout.write(json.dumps({"status": "ok", **payload}, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def _emit_error(message):
    sys.stdout.write(json.dumps({"status": "error", "message": message}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _parse_json_arg(value, default, kind):
    """解析 JSON 字符串参数；失败返回 default 并告警。"""
    if value is None:
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError) as e:
        sys.stderr.write(f"[tracker] --{kind} JSON 解析失败，使用默认值: {e}\n")
        return default


def cmd_record(args):
    """记录一个新 ProvenanceNode，落盘到 --out/<node_id>.json。"""
    try:
        node = make_node(
            operation_type=args.op, agent_name=args.agent, tool_name=args.tool,
            input_node_ids=_parse_json_arg(args.inputs, [], "inputs"),
            output_data_ids=_parse_json_arg(args.outputs, [], "outputs"),
            parameters=_parse_json_arg(args.params, {}, "params"),
            status=args.status, error_message=args.error,
        )
    except ValueError as e:
        _emit_error(str(e))
        return 1
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    fp = out_dir / f"{node['node_id']}.json"
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(node, f, ensure_ascii=False, indent=2)
    _emit_ok({"node_id": node["node_id"], "operation_type": node["operation_type"],
              "path": str(fp).replace("\\", "/")})
    return 0


def cmd_link(args):
    """把 --node 加入 --to 节点的 input_node_ids（去重）。"""
    target_fp = Path(args.out) / f"{args.to}.json"
    if not target_fp.exists():
        _emit_error(f"目标节点文件不存在: {target_fp}")
        return 1
    with open(target_fp, "r", encoding="utf-8") as f:
        target = json.load(f)
    upstreams = target.get("input_node_ids", [])
    if args.node in upstreams:
        _emit_ok({"node_id": target["node_id"], "added": args.node,
                  "input_node_ids": upstreams, "already_linked": True})
        return 0
    upstreams.append(args.node)
    target["input_node_ids"] = upstreams
    with open(target_fp, "w", encoding="utf-8") as f:
        json.dump(target, f, ensure_ascii=False, indent=2)
    _emit_ok({"node_id": target["node_id"], "added": args.node, "input_node_ids": upstreams})
    return 0


def _trace_root_nodes(start_node_id, node_index):
    """从 start_node_id 反向 BFS，返回所有无上游的 root 节点（去重）。"""
    roots, visited, queue = [], set(), [start_node_id]
    while queue:
        cur_id = queue.pop(0)
        if cur_id in visited:
            continue
        visited.add(cur_id)
        cur = node_index.get(cur_id)
        if cur is None:
            continue
        upstreams = cur.get("input_node_ids", [])
        if not upstreams:
            roots.append(cur)
        else:
            queue.extend(up for up in upstreams if up not in visited)
    seen, unique = set(), []
    for r in roots:
        if r["node_id"] not in seen:
            seen.add(r["node_id"])
            unique.append(r)
    return unique


def _source_ref_from_node(node):
    """从 root ProvenanceNode 构造 SourceReference（兜底）。"""
    params = node.get("parameters", {}) or {}
    agent = node.get("agent_name", "")
    source_name = params.get("source_name") or agent.replace(".py", "").replace("_client", "")
    ref = {
        "source_name": source_name or "unknown",
        "source_type": params.get("source_type", "api"),
        "query": params.get("query", json.dumps(params, sort_keys=True, default=str)),
        "retrieved_at": node.get("timestamp", ""),
    }
    for k in ("source_url", "source_doi", "source_pmid", "source_accession", "raw_payload_path"):
        if params.get(k):
            ref[k] = params[k]
    return ref


def _resolve_root_sources(producing_node, node_index, record_index):
    """反查 root 节点，收集 root source 引用。优先用 record 的 source_ref，兜底用节点参数。"""
    roots = _trace_root_nodes(producing_node["node_id"], node_index)
    sources, seen_keys = [], set()
    for root in roots:
        found = False
        for rid in root.get("output_data_ids", []):
            rec = record_index.get(rid)
            if rec is None:
                continue
            ref = rec.get("source_ref")
            ref = dict(ref) if isinstance(ref, dict) and ref else None
            if ref is None:
                continue
            key = json.dumps(ref, sort_keys=True, default=str)
            if key not in seen_keys:
                seen_keys.add(key)
                sources.append(ref)
                found = True
        if not found:  # 兜底：用 root 节点参数构造
            ref = _source_ref_from_node(root)
            key = json.dumps(ref, sort_keys=True, default=str)
            if key not in seen_keys:
                seen_keys.add(key)
                sources.append(ref)
    return sources


def cmd_export(args):
    """加载全部节点 + records，对每条 record 反向追溯 root sources，输出 lineage.json。"""
    nodes = load_nodes(args.nodes_dir)
    if not nodes:
        _emit_error(f"未在 {args.nodes_dir} 中找到任何节点")
        return 1
    is_valid, errors = validate_dag(nodes)  # DAG 校验（不阻断导出，但告警）
    if not is_valid:
        for e in errors:
            sys.stderr.write(f"[tracker] DAG 校验警告: {e}\n")
    node_index = {n["node_id"]: n for n in nodes}
    try:
        records = load_records(args.records)
    except FileNotFoundError as e:
        _emit_error(str(e))
        return 1
    record_index = {r.get("record_id"): r for r in records if r.get("record_id")}
    record_roots, missing = {}, []
    for rec in records:
        rid = rec.get("record_id")
        if not rid:
            continue
        producing = next((n for n in nodes if rid in n.get("output_data_ids", [])), None)
        if producing is None:  # 找不到产出节点：用 record 自身 source_ref 兜底
            ref = rec.get("source_ref")
            ref = dict(ref) if isinstance(ref, dict) and ref else None
            record_roots[rid] = [ref] if ref else []
            missing.append(rid)
            continue
        record_roots[rid] = _resolve_root_sources(producing, node_index, record_index)
    graph, dag_errors = save_lineage(  # save_lineage 内部会做拓扑排序
        task_id=args.task_id, nodes=nodes,
        record_roots=record_roots, output_path=args.out,
    )
    _emit_ok({
        "task_id": graph["task_id"], "node_count": len(graph["nodes"]),
        "record_count": len(record_roots), "dag_valid": is_valid and not dag_errors,
        "dag_errors": dag_errors if dag_errors else errors,
        "records_without_producing_node": missing,
        "path": str(Path(args.out)).replace("\\", "/"),
    })
    return 0


def build_parser():
    """构造命令行解析器（record / link / export 三个子命令）。"""
    parser = argparse.ArgumentParser(prog="tracker.py", description="数据溯源追踪器")
    sub = parser.add_subparsers(dest="command", required=True)
    p_rec = sub.add_parser("record", help="记录一个新 ProvenanceNode")
    p_rec.add_argument("--task-id", required=True, help="任务 ID")
    p_rec.add_argument("--op", required=True, help="search/acquire/parse/clean/analyze/review/export")
    p_rec.add_argument("--agent", required=True, help="agent/脚本名")
    p_rec.add_argument("--tool", default=None, help="工具/函数名")
    p_rec.add_argument("--inputs", default=None, help="上游 node_id 列表 JSON")
    p_rec.add_argument("--outputs", default=None, help="产出 record_id 列表 JSON")
    p_rec.add_argument("--params", default=None, help="参数 JSON")
    p_rec.add_argument("--status", default="success", help="success/partial/failed")
    p_rec.add_argument("--error", default=None, help="错误说明")
    p_rec.add_argument("--out", required=True, help="输出目录")
    p_rec.set_defaults(func=cmd_record)
    p_link = sub.add_parser("link", help="把上游节点加入下游节点的 input_node_ids")
    p_link.add_argument("--node", required=True, help="上游 node_id")
    p_link.add_argument("--to", required=True, help="下游 node_id")
    p_link.add_argument("--out", required=True, help="节点文件所在目录")
    p_link.set_defaults(func=cmd_link)
    p_exp = sub.add_parser("export", help="导出完整 lineage.json")
    p_exp.add_argument("--task-id", required=True, help="任务 ID")
    p_exp.add_argument("--nodes-dir", required=True, help="节点 JSON 文件目录")
    p_exp.add_argument("--records", required=True, help="records JSON 文件或目录")
    p_exp.add_argument("--out", required=True, help="输出 lineage.json 路径")
    p_exp.set_defaults(func=cmd_export)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as e:  # 兜底：未捕获异常输出标准 error 格式
        _emit_error(f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
