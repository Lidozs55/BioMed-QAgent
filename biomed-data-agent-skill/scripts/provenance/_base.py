"""公共基类与工具：ProvenanceNode 构造、加载、DAG 验证、拓扑排序、血缘图保存。

被 tracker.py / query.py 复用。所有路径在代码中以 Unix 风格书写，
运行时使用 pathlib 兼容跨平台。

符合 schemas：
- provenance_node.schema.json （单节点）
- lineage_graph.schema.yaml   （完整血缘图）

设计要点：
- 节点 node_id 形如 <operation>-<hash8>，hash8 由内容+时间戳 md5 截取，保证唯一
- 时间戳统一 UTC ISO 8601（形如 2026-07-05T10:00:00Z）
- DAG 验证采用 Kahn 算法，同时检测自环、悬空引用、重复 id、环
"""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


# 允许的 operation_type 枚举（与 schema 保持一致）
VALID_OPERATIONS = {"search", "acquire", "parse", "clean", "analyze", "review", "export"}

# 允许的 status 枚举
VALID_STATUS = {"success", "partial", "failed"}


def utc_now() -> str:
    """返回当前 UTC 时间的 ISO 8601 字符串，形如 2026-07-05T10:00:00Z。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _hash8(content: str) -> str:
    """对字符串做 md5 取前 8 位，用于生成 node_id 后缀。"""
    return hashlib.md5(content.encode("utf-8")).hexdigest()[:8]


def make_node(
    operation_type,
    agent_name,
    tool_name=None,
    input_node_ids=None,
    output_data_ids=None,
    parameters=None,
    status="success",
    error_message=None,
):
    """构造符合 provenance_node.schema.json 的 ProvenanceNode dict。

    参数：
        operation_type: 操作类型，必须属于 VALID_OPERATIONS
        agent_name: 执行操作的脚本/agent 名称，如 'pubmed_client.py'
        tool_name: 具体工具/函数名，如 'search_pubmed'（可选）
        input_node_ids: 上游节点 id 列表（初始 search 步骤为空）
        output_data_ids: 本次产出的 DataRecord id 列表
        parameters: 本次调用的精确参数 dict（可复现性关键）
        status: 'success' / 'partial' / 'failed'
        error_message: 当 status 非 success 时的错误说明

    返回：
        dict，字段与 provenance_node.schema.json 完全对齐（additionalProperties=false）

    异常：
        ValueError: operation_type 或 status 非法时抛出
    """
    if operation_type not in VALID_OPERATIONS:
        raise ValueError(
            f"非法 operation_type: {operation_type}，允许值: {sorted(VALID_OPERATIONS)}"
        )
    if status not in VALID_STATUS:
        raise ValueError(f"非法 status: {status}，允许值: {sorted(VALID_STATUS)}")

    # 规范化可选字段默认值
    input_node_ids = list(input_node_ids) if input_node_ids else []
    output_data_ids = list(output_data_ids) if output_data_ids else []
    parameters = dict(parameters) if parameters else {}

    # 自动生成时间戳
    timestamp = utc_now()

    # node_id = <operation>-<hash8>，hash 输入包含全部可变字段+时间戳以保证唯一
    raw = "|".join([
        operation_type,
        agent_name,
        tool_name or "",
        json.dumps(input_node_ids, sort_keys=True, default=str),
        json.dumps(output_data_ids, sort_keys=True, default=str),
        json.dumps(parameters, sort_keys=True, default=str),
        timestamp,
    ])
    node_id = f"{operation_type}-{_hash8(raw)}"

    node = {
        "node_id": node_id,
        "operation_type": operation_type,
        "agent_name": agent_name,
        "timestamp": timestamp,
        "input_node_ids": input_node_ids,
        "output_data_ids": output_data_ids,
        "parameters": parameters,
        "status": status,
    }
    # 仅在提供时写入可选字段，保持与 schema additionalProperties=false 一致
    if tool_name is not None:
        node["tool_name"] = tool_name
    if error_message is not None:
        node["error_message"] = error_message
    return node


def _load_json_file(fp):
    """读取单个 JSON 文件，返回 ProvenanceNode 列表。

    支持三种结构：裸数组、单对象、{"nodes": [...]} 信封。
    """
    with open(fp, "r", encoding="utf-8") as f:
        data = json.load(f)
    # 统一成 list[dict]，再过滤出真正具备 node_id 的 ProvenanceNode
    if isinstance(data, dict):
        if "nodes" in data and isinstance(data["nodes"], list):
            items = data["nodes"]
        elif "node_id" in data:
            items = [data]
        else:
            items = []
    elif isinstance(data, list):
        items = data
    else:
        items = []
    # 仅保留含 node_id 的 dict，跳过 DataRecord 等非节点 JSON
    return [it for it in items if isinstance(it, dict) and "node_id" in it]


def load_nodes(input_path):
    """从 JSON 文件或目录加载 ProvenanceNode 列表。

    - input_path 为目录：递归合并所有 .json 文件（每个文件可含单节点或节点数组）
    - input_path 为文件：读取单个 JSON（数组 / 单对象 / {"nodes": [...]} 信封）
    """
    p = Path(input_path)
    if p.is_dir():
        nodes = []
        for fp in sorted(p.rglob("*.json")):
            nodes.extend(_load_json_file(fp))
        return nodes
    if p.is_file():
        return _load_json_file(p)
    raise FileNotFoundError(f"输入路径不存在: {input_path}")


def topological_sort(nodes):
    """对 nodes 做拓扑排序（Kahn 算法）。

    输入：ProvenanceNode 列表
    返回：节点列表，按拓扑序排列（上游在前，下游在后）
          若存在环，返回的列表长度将小于输入长度（剩余节点在环中）

    约定：edge 从 input_node_id → node_id（上游指向下游）
    """
    in_degree = {n["node_id"]: 0 for n in nodes}
    adj = {n["node_id"]: [] for n in nodes}
    node_map = {n["node_id"]: n for n in nodes}

    for n in nodes:
        for up in n.get("input_node_ids", []):
            # 仅在图内存在的边参与排序，悬空引用由 validate_dag 报错
            if up in adj:
                adj[up].append(n["node_id"])
                in_degree[n["node_id"]] += 1

    # 入度为 0 的节点入队（按 node_id 字典序保证输出稳定）
    queue = sorted([nid for nid, d in in_degree.items() if d == 0])
    ordered = []
    while queue:
        cur = queue.pop(0)
        ordered.append(node_map[cur])
        # 邻接点入度 -1，为 0 则入队
        next_ready = []
        for nxt in adj[cur]:
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                next_ready.append(nxt)
        # 保持稳定排序
        queue.extend(sorted(next_ready))
        queue.sort()

    return ordered


def validate_dag(nodes):
    """验证 nodes 形成有效 DAG（无环）。

    检查项：
    1. 重复 node_id
    2. 自环（节点引用自身）
    3. 引用不存在的上游 node_id（悬空引用）
    4. 环（Kahn 算法：若处理节点数 < 总节点数则有环）

    返回：(is_valid: bool, errors: list[str])
    """
    errors = []

    # 1. 重复 node_id
    seen = set()
    dup = set()
    for n in nodes:
        nid = n.get("node_id", "")
        if nid in seen:
            dup.add(nid)
        seen.add(nid)
    for nid in sorted(dup):
        errors.append(f"重复的 node_id: {nid}")

    node_ids = set(n.get("node_id", "") for n in nodes)

    # 2. 自环
    for n in nodes:
        for up in n.get("input_node_ids", []):
            if up == n.get("node_id"):
                errors.append(f"节点 {n.get('node_id')} 存在自环")

    # 3. 悬空引用
    for n in nodes:
        for up in n.get("input_node_ids", []):
            if up not in node_ids:
                errors.append(
                    f"节点 {n.get('node_id')} 引用了不存在的上游节点: {up}"
                )

    # 4. 环检测：拓扑排序后若节点数不足则有环
    if not errors:
        ordered = topological_sort(nodes)
        if len(ordered) != len(nodes):
            in_cycle = set(node_ids) - set(o["node_id"] for o in ordered)
            errors.append(
                f"检测到环，涉及节点: {', '.join(sorted(in_cycle))}"
            )

    return (len(errors) == 0, errors)


def save_lineage(task_id, nodes, record_roots, output_path):
    """构造 lineage graph 并保存到 output_path。

    符合 lineage_graph.schema.yaml：
        task_id:       任务 ID
        generated_at:  生成时间（UTC ISO 8601）
        nodes:         拓扑排序后的 ProvenanceNode 列表
        record_roots:  {record_id: [SourceReference, ...]}

    参数：
        task_id: 任务 ID
        nodes: ProvenanceNode 列表（会被拓扑排序后写入）
        record_roots: record_id → root source 引用列表的映射
        output_path: 输出 JSON 文件路径（自动创建父目录）
    """
    # 先做 DAG 验证，环存在时仍写入但保持原序（让调用方决定是否中止）
    is_valid, errors = validate_dag(nodes)
    if is_valid:
        ordered_nodes = topological_sort(nodes)
    else:
        # 有环时退化为原序，避免 topological_sort 截断丢节点
        ordered_nodes = list(nodes)

    graph = {
        "task_id": task_id,
        "generated_at": utc_now(),
        "nodes": ordered_nodes,
        "record_roots": record_roots or {},
    }

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(graph, f, ensure_ascii=False, indent=2)

    return graph, errors


def load_records(input_path):
    """从 JSON 文件或目录加载 DataRecord 列表。

    与 load_nodes 平行，但加载 DataRecord（含 record_id / fields / source_ref）。
    支持裸数组、单对象、{"records": [...]} 信封。
    """
    p = Path(input_path)
    records = []

    def _extract(data):
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            if "records" in data and isinstance(data["records"], list):
                return data["records"]
            return [data]
        return []

    if p.is_dir():
        for fp in sorted(p.rglob("*.json")):
            with open(fp, "r", encoding="utf-8") as f:
                records.extend(_extract(json.load(f)))
    elif p.is_file():
        with open(p, "r", encoding="utf-8") as f:
            records = _extract(json.load(f))
    else:
        raise FileNotFoundError(f"records 路径不存在: {input_path}")
    return records
