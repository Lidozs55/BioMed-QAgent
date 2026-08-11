"""Tests for mid-run context injection (store, instructions, HTTP endpoint)."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.agent_loop.agent import resolve_agent_instructions
from app.agent_loop.context import RunContext
from app.agent_loop.context_injection import get_context_injection_store
from app.config import Settings
from app.main import create_app

TASK_ID = "task-injection-test"


@pytest.fixture(autouse=True)
def _clean_injections() -> None:
    store = get_context_injection_store()
    store.clear(TASK_ID)
    yield
    store.clear(TASK_ID)


def test_store_inject_pending_drain() -> None:
    store = get_context_injection_store()
    assert store.inject(TASK_ID, "  first  ") == 1
    assert store.inject(TASK_ID, "second") == 2
    assert store.pending(TASK_ID) == ["first", "second"]
    assert store.drain(TASK_ID) == ["first", "second"]
    assert store.pending(TASK_ID) == []
    assert store.drain(TASK_ID) == []


def test_injected_text_appears_in_instructions_once(tmp_path: Path) -> None:
    store = get_context_injection_store()
    store.inject(TASK_ID, "请优先查看 README.md")
    run_ctx = RunContext(task_id=TASK_ID, base_dir=tmp_path)

    first = resolve_agent_instructions("BASE", run_ctx)
    assert "用户中途注入的上下文" in first
    assert "请优先查看 README.md" in first

    # 本轮模型调用后一次性消费：drain 后不再出现。
    run_ctx.drain_context_injections()
    second = resolve_agent_instructions("BASE", run_ctx)
    assert "用户中途注入的上下文" not in second


@pytest.mark.asyncio
async def test_inject_context_endpoint(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        created = await client.post(
            "/api/v1/tasks",
            json={
                "request_id": "req-inject-test",
                "input": "research",
                "databases": [],
            },
        )
        assert created.status_code == 202
        task_id = created.json()["task_id"]
        store = get_context_injection_store()
        store.clear(task_id)
        try:
            injected = await client.post(
                f"/api/v1/tasks/{task_id}/inject-context",
                json={"text": "注意：补充说明"},
            )
            assert injected.status_code == 202
            assert injected.json()["pending"] == 1
            assert store.pending(task_id) == ["注意：补充说明"]
            # 注入内容持久化为对话记录中的用户消息。
            page = await client.get(f"/api/v1/tasks/{task_id}/messages")
            assert page.status_code == 200
            contents = [
                message["content"]
                for message in page.json()["messages"]
                if message["role"] == "user"
            ]
            assert "注意：补充说明" in contents
            # 注入内容只用于展示，不进入模型可见的会话历史。
            repository = application.state.task_repository
            model_items = await repository.task_session(task_id).get_items()
            assert all(
                "注意：补充说明" not in str(item) for item in model_items
            )
        finally:
            store.clear(task_id)
