"""溯源追踪器 — 记录每条数据的处理链路。

每条最终输出数据可追溯到原始来源和完整处理过程，
满足赛题"来源可追溯性"评分维度。
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


class ProvenanceNode:
    """溯源图中的一个节点。"""

    def __init__(self, node_id: str = "", operation_type: str = "",
                 agent_name: str = "", tool_name: str = "",
                 input_node_ids: list[str] | None = None,
                 output_record_ids: list[str] | None = None,
                 parameters: dict | None = None):
        self.node_id = node_id or f"N{uuid.uuid4().hex[:8]}"
        self.operation_type = operation_type  # search|acquire|parse|clean|analyze|review
        self.agent_name = agent_name
        self.tool_name = tool_name
        self.input_node_ids = input_node_ids or []
        self.output_record_ids = output_record_ids or []
        self.parameters = parameters or {}
        self.timestamp = datetime.now().isoformat()

    def to_dict(self) -> dict:
        return {
            "node_id": self.node_id,
            "operation_type": self.operation_type,
            "agent_name": self.agent_name,
            "tool_name": self.tool_name,
            "input_node_ids": self.input_node_ids,
            "output_record_ids": self.output_record_ids,
            "parameters": self.parameters,
            "timestamp": self.timestamp,
        }


class ProvenanceTracker:
    """溯源追踪器。

    记录每个操作节点，构建完整的处理链路图。
    """

    def __init__(self, task_id: str):
        self.task_id = task_id
        self.nodes: list[ProvenanceNode] = []
        self._record_to_nodes: dict[str, list[str]] = {}  # record_id -> [node_id]

    def record(self, operation_type: str, agent_name: str, tool_name: str = "",
               input_records: list[str] | None = None,
               output_records: list[str] | None = None,
               parameters: dict | None = None) -> ProvenanceNode:
        """记录一个操作节点。"""
        input_ids = []
        if input_records:
            for rid in input_records:
                if rid in self._record_to_nodes:
                    input_ids.extend(self._record_to_nodes[rid])

        node = ProvenanceNode(
            operation_type=operation_type,
            agent_name=agent_name,
            tool_name=tool_name,
            input_node_ids=input_ids,
            output_record_ids=output_records or [],
            parameters=parameters or {},
        )
        self.nodes.append(node)

        for rid in (output_records or []):
            if rid not in self._record_to_nodes:
                self._record_to_nodes[rid] = []
            self._record_to_nodes[rid].append(node.node_id)
        return node

    def get_lineage(self, record_id: str) -> list[dict]:
        """获取某条记录的溯源链（从根到当前）。"""
        chain: list[ProvenanceNode] = []
        visited: set[str] = set()
        node_ids = self._record_to_nodes.get(record_id, [])

        def _walk_up(nid: str):
            if nid in visited:
                return
            visited.add(nid)
            for node in self.nodes:
                if node.node_id == nid:
                    chain.append(node)
                    for parent_id in node.input_node_ids:
                        _walk_up(parent_id)

        for nid in node_ids:
            _walk_up(nid)
        chain.reverse()
        return [n.to_dict() for n in chain]

    def to_graph(self) -> dict:
        """导出完整溯源图。"""
        return {
            "task_id": self.task_id,
            "nodes": [n.to_dict() for n in self.nodes],
            "edges": [
                {"source": nid, "target": n.node_id}
                for n in self.nodes for nid in n.input_node_ids
            ],
            "stats": {
                "total_nodes": len(self.nodes),
                "total_records_tracked": len(self._record_to_nodes),
            },
        }

    def save(self, output_dir: Path):
        """保存溯源图到文件。"""
        graph = self.to_graph()
        path = output_dir / "lineage.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(graph, f, ensure_ascii=False, indent=2)
        return path

    def load(self, output_dir: Path) -> bool:
        """从 lineage.json 恢复溯源图。

        后端重启后内存丢失时调用，重建 nodes 与 _record_to_nodes 索引。
        返回是否成功加载。
        """
        path = output_dir / "lineage.json"
        if not path.exists():
            return False
        try:
            with open(path, "r", encoding="utf-8") as f:
                graph = json.load(f)
            self.nodes = []
            self._record_to_nodes = {}
            for n in graph.get("nodes", []):
                node = ProvenanceNode(
                    node_id=n.get("node_id", ""),
                    operation_type=n.get("operation_type", ""),
                    agent_name=n.get("agent_name", ""),
                    tool_name=n.get("tool_name", ""),
                    input_node_ids=n.get("input_node_ids", []),
                    output_record_ids=n.get("output_record_ids", []),
                    parameters=n.get("parameters", {}),
                )
                node.timestamp = n.get("timestamp", node.timestamp)
                self.nodes.append(node)
                for rid in node.output_record_ids:
                    self._record_to_nodes.setdefault(rid, []).append(node.node_id)
            return True
        except Exception:
            return False
