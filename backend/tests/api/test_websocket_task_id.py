from __future__ import annotations

import app.api.ws as ws_module
from app.main import app
from fastapi.testclient import TestClient


def test_websocket_assigns_unique_task_id_before_agent_events(monkeypatch) -> None:
    observed: list[str] = []

    async def fake_stream(user_input: str, task_id: str, databases=None):
        observed.append(task_id)
        yield {"type": "done", "final_output": user_input}

    monkeypatch.setattr(ws_module, "run_agent_stream", fake_stream)

    with TestClient(app).websocket_connect("/api/v1/ws") as websocket:
        websocket.send_json(
            {
                "type": "run",
                "input": "first",
                "databases": ["pubmed", "geo"],
            }
        )
        started = websocket.receive_json()
        done = websocket.receive_json()

    assert started["type"] == "task_started"
    assert started["task_id"].startswith("task_")
    assert observed == [started["task_id"]]
    assert done == {"type": "done", "final_output": "first"}
