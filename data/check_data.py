import urllib.request, json
resp = urllib.request.urlopen("http://127.0.0.1:8000/api/v1/tasks/Td210d6b0/data?limit=3")
data = json.loads(resp.read().decode("utf-8"))
print(f"Total: {data['total']}, Sources: {data['sources']}")
for r in data["records"]:
    src = r.get("source_ref", {}).get("source_name", "")
    conf = r.get("extraction_confidence", 0)
    title = r.get("fields", {}).get("title", "")[:50]
    print(f"  - {src:20s} conf={conf:.2f} | {title}")
