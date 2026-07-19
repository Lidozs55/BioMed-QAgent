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

from app.agent_loop.runner import ModeDispatchRunExecutor
from app.api.routes import load_database_skills
from app.api.routes import router as routes_router
from app.api.ws import router as ws_router
from app.config import Settings, settings
from app.runtime.hub import AssistantStreamHub, EventHub
from app.runtime.index import SingleThreadExecutor, TaskIndex
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

_STORAGE_WORKER_THREADS = 2


async def health() -> dict[str, str]:
    return {"status": "ok", "version": "1.0.0", "arch": "agent_loop"}


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
        storage_executor = ThreadPoolExecutor(
            max_workers=_STORAGE_WORKER_THREADS,
            thread_name_prefix="task-storage",
        )
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
            storage_executor=storage_executor,
        )
        event_hub = EventHub(
            subscriber_queue_size=configured.runtime_subscriber_queue_size
        )
        assistant_stream_hub = AssistantStreamHub(
            subscriber_queue_size=configured.runtime_subscriber_queue_size
        )
        manager = TaskManager(
            repository,
            run_executor=ModeDispatchRunExecutor(repository),
            max_active_runs=configured.runtime_max_active_runs,
            max_queued_runs=configured.runtime_run_queue_size,
            event_hub=event_hub,
            assistant_stream_hub=assistant_stream_hub,
        )
        application.state.sync_executor = sync_executor
        application.state.storage_executor = storage_executor
        application.state.index_executor = index_executor
        application.state.task_repository = repository
        application.state.event_hub = event_hub
        application.state.assistant_stream_hub = assistant_stream_hub
        application.state.task_manager = manager
        # Register stable user-selectable database skills once at startup so
        # GET /api/v1/databases does not re-register them on every request.
        load_database_skills()
        try:
            await manager.start()
            yield
        finally:
            try:
                await manager.close()
            finally:
                try:
                    await assistant_stream_hub.close()
                finally:
                    try:
                        await event_hub.close()
                    finally:
                        try:
                            await index_executor.close()
                        finally:
                            try:
                                storage_executor.shutdown(wait=True)
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
