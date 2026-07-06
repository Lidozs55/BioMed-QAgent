import urllib.request, json, sys
task_id = sys.argv[1] if len(sys.argv) > 1 else "T65d3b6d1"
resp = urllib.request.urlopen(f"http://127.0.0.1:8000/api/v1/tasks/{task_id}")
data = json.loads(resp.read().decode("utf-8"))
print(f"Status: {data['status']}")
print(f"Records: {data['total_records']}  Sources: {data['source_count']}  AvgConf: {data['avg_confidence']:.4f}")
print(f"Errors: {len(data['errors'])}")
for k, v in data["stages"].items():
    print(f"  {k:10s}: {v['status']:8s} records={v['records_count']:3d} | {v['message'][:90]}")
print("\nEntities:")
for cat, items in data.get("entities", {}).items():
    if items:
        print(f"  {cat}: {items[:8]}")
