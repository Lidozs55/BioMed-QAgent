"""FastAPI application and runtime lifespan ownership."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as routes_router
from app.api.ws import router as ws_router
from app.config import Settings, settings
from app.runtime.hub import EventHub
from app.runtime.index import SingleThreadExecutor, TaskIndex
from app.runtime.manager import RunExecution, TaskManager
from app.runtime.repository import TaskRepository

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)


async def health() -> dict[str, str]:
    return {"status": "ok", "version": "1.0.0", "arch": "agent_loop"}


async def _execution_not_configured(execution: RunExecution) -> None:
    raise RuntimeError(
        f"runtime execution is not configured for run {execution.run_id}"
    )


def create_app(configured: Settings = settings) -> FastAPI:
    """Build an application whose lifespan owns all runtime resources."""

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        loop = asyncio.get_running_loop()
        sync_executor = ThreadPoolExecutor(
            max_workers=configured.runtime_sync_worker_threads,
            thread_name_prefix="task-sync",
        )
        loop.set_default_executor(sync_executor)
        index_executor = SingleThreadExecutor()
        index = TaskIndex(
            Path(configured.output_dir) / "tasks",
            executor=index_executor,
            settings=configured,
        )
        repository = TaskRepository(
            configured.output_dir,
            index=index,
            settings=configured,
        )
        event_hub = EventHub(
            subscriber_queue_size=configured.runtime_subscriber_queue_size
        )
        manager = TaskManager(
            repository,
            run_executor=_execution_not_configured,
            max_active_runs=configured.runtime_max_active_runs,
            max_queued_runs=configured.runtime_run_queue_size,
            event_hub=event_hub,
        )
        application.state.sync_executor = sync_executor
        application.state.index_executor = index_executor
        application.state.task_repository = repository
        application.state.event_hub = event_hub
        application.state.task_manager = manager
        try:
            await manager.start()
            yield
        finally:
            try:
                await manager.close()
            finally:
                try:
                    await event_hub.close()
                finally:
                    try:
                        await index_executor.close()
                    finally:
                        sync_executor.shutdown(wait=True)

    application = FastAPI(
        title="BioMed QAgent v1",
        version="1.0.0",
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(routes_router)
    application.include_router(ws_router)
    application.add_api_route("/api/v1/health", health, methods=["GET"])
    return application


app = create_app()
