import urllib.request, json
resp = urllib.request.urlopen("http://127.0.0.1:8000/api/v1/tasks?limit=3")
data = json.loads(resp.read().decode("utf-8"))
print(f"Tasks: {data['total']}")
for t in data["tasks"][:3]:
    print(f"  {t['task_id']} | {t['status']:10s} | rec={t['total_records']:3d} | {t['research_goal'][:30]}")
