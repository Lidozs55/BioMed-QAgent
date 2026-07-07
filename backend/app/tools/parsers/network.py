"""network.py — 网络文件解析器。

用途：把多种网络格式解析成统一的网络 DataRecord。

支持格式：
    - STRING TSV：列含 #node1, #node2, neighborhood, ..., combined_score
    - Cytoscape SIF：nodeA <relationship type> nodeB
    - GraphML：基于 XML（用标准库 xml.etree）

输入：
    parse(file_path, fmt="auto") —— fmt 可选 auto/string/sif/graphml，默认 auto

输出格式：
    一个 record，fields 含：
      nodes (list of {id, label}), edges (list of {source, target, weight, evidence}),
      node_count, edge_count, format, entity_type。

自动检测规则：
    首行含 #node1 或 combined_score -> string
    首行含 <?xml 或 <graphml       -> graphml
    首行 3 列且第二列为关系类型      -> sif

示例：
    from .network import NetworkParser
    parser = NetworkParser()
    records = parser.parse("network.tsv", fmt="auto")

依赖：仅标准库。
"""
import xml.etree.ElementTree as ET

from ._base import BaseParser, make_record


def detect_network_format(file_path):
    """自动检测网络格式：string / sif / graphml。"""
    try:
        with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
            first = ""
            for _ in range(5):
                line = f.readline()
                if not line:
                    break
                if line.strip():
                    first = line
                    break
        low = first.lower()
        if low.startswith("<?xml") or "<graphml" in low:
            return "graphml"
        if "#node1" in low or "combined_score" in low:
            return "string"
        cols = first.split("\t") if "\t" in first else first.split()
        if len(cols) == 3 and cols[1].isalpha():
            return "sif"
    except OSError:
        pass
    return "string"


def parse_string_tsv(file_path):
    """解析 STRING TSV 格式。"""
    nodes = {}
    edges = []
    header = None
    with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n").rstrip("\r")
            if not line:
                continue
            cols = line.split("\t")
            if header is None:
                # 去掉表头首列的 #
                header = [c.lstrip("#").strip() for c in cols]
                continue
            try:
                row = dict(zip(header, cols))
            except Exception:
                continue
            n1 = row.get("node1", "").strip() or row.get("stringId_a", "").strip()
            n2 = row.get("node2", "").strip() or row.get("stringId_b", "").strip()
            if not n1 or not n2:
                continue
            nodes.setdefault(n1, {"id": n1, "label": n1})
            nodes.setdefault(n2, {"id": n2, "label": n2})
            try:
                weight = float(row.get("combined_score", 0))
            except ValueError:
                weight = 0.0
            evidence = {k: v for k, v in row.items()
                        if k not in ("node1", "node2") and v}
            edges.append({"source": n1, "target": n2,
                          "weight": weight, "evidence": evidence})
    return list(nodes.values()), edges


def parse_sif(file_path):
    """解析 Cytoscape SIF 格式：nodeA <relationship> nodeB [nodeC ...]。"""
    nodes = {}
    edges = []
    with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n").rstrip("\r").strip()
            if not line:
                continue
            parts = line.split("\t") if "\t" in line else line.split()
            if len(parts) < 3:
                continue
            src, rel = parts[0], parts[1]
            for tgt in parts[2:]:
                nodes.setdefault(src, {"id": src, "label": src})
                nodes.setdefault(tgt, {"id": tgt, "label": tgt})
                edges.append({"source": src, "target": tgt,
                              "weight": 1.0,
                              "evidence": {"relationship": rel}})
    return list(nodes.values()), edges


def parse_graphml(file_path):
    """解析 GraphML 格式（标准库 xml.etree）。"""
    nodes = {}
    edges = []
    try:
        tree = ET.parse(file_path)
    except ET.ParseError as e:
        raise RuntimeError(f"GraphML XML 解析失败: {e}")
    root = tree.getroot()
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    def tag(name):
        return f"{ns}{name}" if ns else name

    for node in root.iter(tag("node")):
        nid = node.get("id", "")
        if not nid:
            continue
        label = nid
        for d in node.iter(tag("data")):
            if d.text:
                label = d.text.strip()
                break
        nodes[nid] = {"id": nid, "label": label}
    for edge in root.iter(tag("edge")):
        src, tgt = edge.get("source", ""), edge.get("target", "")
        if not src or not tgt:
            continue
        nodes.setdefault(src, {"id": src, "label": src})
        nodes.setdefault(tgt, {"id": tgt, "label": tgt})
        weight, evidence = 1.0, {}
        for d in edge.iter(tag("data")):
            key = d.get("key", "value")
            try:
                val = float(d.text)
                if key in ("weight", "edge_weight"):
                    weight = val
                else:
                    evidence[key] = val
            except (ValueError, TypeError):
                if d.text:
                    evidence[key] = d.text.strip()
        edges.append({"source": src, "target": tgt,
                      "weight": weight, "evidence": evidence})
    return list(nodes.values()), edges


class NetworkParser(BaseParser):
    """多格式网络解析器。"""

    source_name = "network"

    def parse(self, file_path, fmt="auto"):
        if fmt == "auto":
            fmt = detect_network_format(file_path)
        if fmt == "string":
            nodes, edges = parse_string_tsv(file_path)
        elif fmt == "sif":
            nodes, edges = parse_sif(file_path)
        elif fmt == "graphml":
            nodes, edges = parse_graphml(file_path)
        else:
            raise ValueError(f"未知网络格式: {fmt}")
        fields = {
            "nodes": nodes,
            "edges": edges,
            "node_count": len(nodes),
            "edge_count": len(edges),
            "format": fmt,
            "entity_type": "Network",
        }
        return [make_record(
            task_id="", source_name=self.source_name,
            fields=fields, file_path=file_path,
            confidence=0.9, method="table",
            accession=None, source_type="file")]
