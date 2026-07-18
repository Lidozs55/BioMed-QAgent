from __future__ import annotations

from pathlib import Path

import pytest
from app.config import Settings
from app.main import create_app
from app.runtime.hub import AssistantStreamHub


@pytest.mark.asyncio
async def test_lifespan_owns_and_always_closes_assistant_stream_hub(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    application = create_app(
        Settings(
            output_dir=str(tmp_path / "output"),
            runtime_subscriber_queue_size=7,
        )
    )

    with pytest.raises(RuntimeError, match="cleanup failed"):
        async with application.router.lifespan_context(application):
            hub = application.state.assistant_stream_hub
            assert isinstance(hub, AssistantStreamHub)
            assert hub.subscriber_queue_size == 7
            assert hub is not application.state.event_hub
            assert application.state.task_manager.assistant_stream_hub is hub
            subscription = await hub.subscribe()
            manager_close = application.state.task_manager.close

            async def fail_manager_close() -> None:
                await manager_close()
                raise RuntimeError("cleanup failed")

            monkeypatch.setattr(
                application.state.task_manager,
                "close",
                fail_manager_close,
            )

    assert subscription.closed
