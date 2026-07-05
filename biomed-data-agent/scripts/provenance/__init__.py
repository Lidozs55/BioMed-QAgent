"""数据溯源（Provenance）子包：ProvenanceNode 构造、DAG 验证、血缘图导出与查询。

包含模块：
- _base.py: 公共工具（make_node / load_nodes / save_lineage / validate_dag / topological_sort）
- tracker.py: 有状态溯源追踪器 CLI（record / link / export）
- query.py: 溯源链查询工具（text / json 输出）
"""
