"""溯源查询工具：查询某条 record 的完整溯源链与 root sources。

接口：
  python scripts/provenance/query.py --lineage lineage.json \
      --record-id pubmed-a1b2c3d4 --format text

支持 --format text（人类可读）/ json（机器可读）。
可选 --records 传入 records JSON 用于显示字段。

text 输出示例：
  Record: pubmed-a1b2c3d4
  Fields: gene_symbol=AKT1, log2fc=2.35
  [search] ... ↓ [clean] ...
  Root sources: - PubMed PMID: 12345678
"""
import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from _base import load_records  # noqa: E402


def _find_chain(record_id, nodes):
    """反向 BFS 至 root，返回 root→leaf 节点链（多匹配时取最下游产出节点）。"""
    node_index = {n["node_id"]: n for n in nodes}
    producing = next((n for n in reversed(nodes) if record_id in n.get("output_data_ids", [])), None)
    if not producing:
        return []
    visited, chain, queue = set(), [], [producing["node_id"]]
    while queue:
        cur_id = queue.pop(0)
        if cur_id in visited:
            continue
        visited.add(cur_id)
        cur = node_index.get(cur_id)
        if cur is None:
            continue
        chain.append(cur)
        queue.extend(up for up in cur.get("input_node_ids", []) if up not in visited)
    chain.reverse()  # root→leaf
    return chain


def _format_param_line(node):
    """把节点 parameters 压成一行可读摘要。"""
    params = node.get("parameters", {}) or {}
    if not params:
        return ""
    return ", ".join(
        f'{k}: "{v}"' if isinstance(v, str)
        else f"{k}: {json.dumps(v, ensure_ascii=False, default=str)}"
        for k, v in params.items()
    )


def _format_root_sources(sources):
    """格式化 root source 引用列表。"""
    lines = []
    for ref in sources:
        if not isinstance(ref, dict):
            continue
        items = [("PubMed PMID", ref.get("source_pmid")), ("DOI", ref.get("source_doi")),
                 ("URL", ref.get("source_url")), ("Accession", ref.get("source_accession"))]
        lines.extend(f"- {label}: {val}" for label, val in items if val)
        if not any(val for _, val in items):
            lines.append(f"- {ref.get('source_name', 'unknown')}: {ref.get('query', '')}")
    return lines if lines else ["(none)"]


def query_text(lineage, record_id, records_index=None):
    """生成 text 格式溯源报告。"""
    out = [f"Record: {record_id}"]
    if records_index and record_id in records_index:
        fields = records_index[record_id].get("fields", {}) or {}
        if fields:
            out.append("Fields: " + ", ".join(f"{k}={v}" for k, v in fields.items()))
    out.append("")
    chain = _find_chain(record_id, lineage.get("nodes", []))
    out.append("Lineage chain:")
    if not chain:
        out.append("  (未找到产出该 record 的节点)")
    for i, node in enumerate(chain):
        tool = node.get("tool_name", "")
        out.append(f"[{node.get('operation_type', '?')}] {node.get('timestamp', '?')} "
                   f"{node.get('agent_name', '?')}{(' / ' + tool) if tool else ''}")
        summary = _format_param_line(node)
        if summary:
            out.append(f"  {summary}")
        if i < len(chain) - 1:
            out.append("  ↓")
    out.append("")
    out.append("Root sources:")
    out.extend(_format_root_sources(lineage.get("record_roots", {}).get(record_id, [])))
    return "\n".join(out)


def query_json(lineage, record_id, records_index=None):
    """生成 json 格式溯源报告（返回 JSON 字符串）。"""
    chain = _find_chain(record_id, lineage.get("nodes", []))
    fields = records_index[record_id].get("fields", {}) if records_index and record_id in records_index else {}
    result = {
        "record_id": record_id,
        "fields": fields,
        "lineage_chain": [
            {"node_id": n.get("node_id"), "operation_type": n.get("operation_type"),
             "timestamp": n.get("timestamp"), "agent_name": n.get("agent_name"),
             "tool_name": n.get("tool_name"), "parameters": n.get("parameters", {}),
             "input_node_ids": n.get("input_node_ids", [])}
            for n in chain
        ],
        "root_sources": lineage.get("record_roots", {}).get(record_id, []),
    }
    return json.dumps(result, ensure_ascii=False, indent=2)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="query.py", description="查询某条 record 的完整溯源链")
    parser.add_argument("--lineage", required=True, help="lineage.json 文件路径")
    parser.add_argument("--record-id", required=True, help="要查询的 record_id")
    parser.add_argument("--format", choices=["text", "json"], default="text", help="输出格式")
    parser.add_argument("--records", default=None, help="可选：records JSON 用于显示字段")
    args = parser.parse_args(argv)
    try:
        with open(args.lineage, "r", encoding="utf-8") as f:
            lineage = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        sys.stdout.write(json.dumps({"status": "error", "message": str(e)}) + "\n")
        return 1
    records_index = None
    if args.records:
        try:
            recs = load_records(args.records)
            records_index = {r.get("record_id"): r for r in recs if r.get("record_id")}
        except FileNotFoundError as e:
            sys.stderr.write(f"[query] {e}\n")
    if args.format == "json":
        sys.stdout.write(query_json(lineage, args.record_id, records_index) + "\n")
    else:
        sys.stdout.write(query_text(lineage, args.record_id, records_index) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
