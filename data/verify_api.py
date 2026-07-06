import urllib.request, json

# 1. List tasks
resp = urllib.request.urlopen("http://127.0.0.1:8000/api/v1/tasks?limit=5")
data = json.loads(resp.read().decode("utf-8"))
print("=== Tasks List ===")
print(f"Total: {data['total']}")
for t in data["tasks"]:
    print(f"  {t['task_id']} | {t['status']:10s} | rec={t['total_records']:3d} | {t['research_goal'][:30]}")

# 2. Data endpoint
print("\n=== Data (T65d3b6d1) ===")
resp = urllib.request.urlopen("http://127.0.0.1:8000/api/v1/tasks/T65d3b6d1/data?limit=3")
data = json.loads(resp.read().decode("utf-8"))
print(f"Total: {data['total']}, Sources: {data['sources']}")
for r in data["records"]:
    src = r.get("source_ref", {}).get("source_name", "")
    print(f"  - {src:20s} conf={r.get('extraction_confidence', 0):.2f}")

# 3. Files endpoint
print("\n=== Output Files ===")
resp = urllib.request.urlopen("http://127.0.0.1:8000/api/v1/tasks/T65d3b6d1/files")
data = json.loads(resp.read().decode("utf-8"))
for f in data["files"]:
    print(f"  {f['name']:30s} {f['size']:>8d} bytes")

# 4. Lineage
print("\n=== Lineage ===")
resp = urllib.request.urlopen("http://127.0.0.1:8000/api/v1/tasks/T65d3b6d1/lineage")
data = json.loads(resp.read().decode("utf-8"))
print(f"Nodes: {len(data.get('nodes', []))}, Edges: {len(data.get('edges', []))}")
