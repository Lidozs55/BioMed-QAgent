import urllib.request, json, time, sys

# 创建任务
body = json.dumps({
    "research_goal": "分析健脾散结方对胰腺癌肝转移的影响",
    "domain_hint": "tcm_oncology",
    "max_sources": 10,
    "enable_analysis": True,
}).encode("utf-8")
req = urllib.request.Request(
    "http://127.0.0.1:8000/api/v1/tasks",
    data=body,
    headers={"Content-Type": "application/json; charset=utf-8"},
    method="POST",
)
resp = urllib.request.urlopen(req)
data = json.loads(resp.read().decode("utf-8"))
task_id = data["task_id"]
print(f"Created task: {task_id}")

# 启动任务
req = urllib.request.Request(
    f"http://127.0.0.1:8000/api/v1/tasks/{task_id}/start",
    data=b"",
    method="POST",
)
urllib.request.urlopen(req)
print("Started.")

# 轮询等待完成
for i in range(60):
    time.sleep(8)
    resp = urllib.request.urlopen(f"http://127.0.0.1:8000/api/v1/tasks/{task_id}")
    t = json.loads(resp.read().decode("utf-8"))
    status = t["status"]
    cur_stage = next((k for k, v in t["stages"].items() if v["status"] == "running"), None)
    done = sum(1 for v in t["stages"].values() if v["status"] == "done")
    print(f"[{i*8:3d}s] status={status} done={done}/8 cur={cur_stage}")
    if status in ("completed", "failed"):
        break

# 最终状态
print("\n=== Final Status ===")
print(f"Status: {t['status']}, Records: {t['total_records']}, Sources: {t['source_count']}")
for k, v in t["stages"].items():
    print(f"  {k:10s}: {v['status']:8s} | {v['message'][:80]}")

# 检查 lineage
print("\n=== Lineage ===")
resp = urllib.request.urlopen(f"http://127.0.0.1:8000/api/v1/tasks/{task_id}/lineage")
lineage = json.loads(resp.read().decode("utf-8"))
print(f"Nodes: {len(lineage.get('nodes', []))}, Edges: {len(lineage.get('edges', []))}")
for n in lineage.get("nodes", [])[:5]:
    print(f"  {n['node_id']} | {n['operation_type']:10s} | tool={n.get('tool_name','')} | outputs={len(n.get('output_record_ids',[]))}")

# 检查文件
print("\n=== Output Files ===")
resp = urllib.request.urlopen(f"http://127.0.0.1:8000/api/v1/tasks/{task_id}/files")
files = json.loads(resp.read().decode("utf-8"))["files"]
for f in files:
    print(f"  {f['name']:30s} {f['size']:>8d} bytes")
