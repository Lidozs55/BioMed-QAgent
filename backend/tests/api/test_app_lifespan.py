from __future__ import annotations

import pytest
from app.config import Settings
from app.main import create_app
from app.subagents.input_broker import SubagentInputBroker
from app.subagents.supervisor import SubagentSupervisor


@pytest.mark.asyncio
async def test_lifespan_owns_subagent_runtime_and_stops_it_before_manager(
    tmp_path,
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    shutdown_order: list[str] = []

    async with application.router.lifespan_context(application):
        supervisor = application.state.subagent_supervisor
        broker = application.state.subagent_input_broker
        manager = application.state.task_manager

        assert isinstance(supervisor, SubagentSupervisor)
        assert isinstance(broker, SubagentInputBroker)
        assert manager._subagent_supervisor is supervisor
        assert manager._subagent_input_broker is broker

        original_supervisor_shutdown = supervisor.shutdown
        original_manager_close = manager.close

        async def shutdown_supervisor() -> None:
            shutdown_order.append("supervisor")
            await original_supervisor_shutdown()

        async def close_manager() -> None:
            shutdown_order.append("manager")
            await original_manager_close()

        supervisor.shutdown = shutdown_supervisor
        manager.close = close_manager

    assert shutdown_order == ["supervisor", "manager"]
