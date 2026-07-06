import sys
sys.path.insert(0, "backend")
from app.storage.task_store import get_task_store

store = get_task_store()
print(f"Tasks in memory: {len(store._tasks)}")
print(f"Records keys: {list(store._records.keys())}")
for tid, recs in store._records.items():
    print(f"  {tid}: {len(recs)} records")
