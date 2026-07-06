import sys
sys.path.insert(0, "backend")
from app.storage.task_store import get_task_store

store = get_task_store()
prov = store.get_provenance("T65d3b6d1")
if prov is None:
    print("ProvenanceTracker is None!")
else:
    print(f"Provenance nodes: {len(prov.nodes)}")
    print(f"Records tracked: {len(prov._record_to_nodes)}")
    for n in prov.nodes[:5]:
        print(f"  {n.node_id} | {n.operation_type} | {n.tool_name} | outputs={len(n.output_record_ids)}")
