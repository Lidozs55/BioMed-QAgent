"""FastAPI application and runtime lifespan ownership."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.agent_loop.runner import ModeDispatchRunExecutor
from app.api.routes import router as routes_router
from app.api.settings import router as settings_router
from app.api.skills import router as skills_router
from app.api.ws import router as ws_router
from app.config import Settings, settings
from app.model_settings import ModelSettingsStore, set_current_model_settings_store
from app.runtime.hub import AssistantStreamHub, EventHub
from app.runtime.index import SingleThreadExecutor, TaskIndex
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository
from app.skills.builtin import load_builtin_skill_descriptors
from app.skills.catalog import SkillCatalog
from app.skills.store import UserSkillStore
from app.tools.cache_store import init_cache_store

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

# TODO §1.7: structured JSON logging for pipeline audit events.
# Each EventEnvelope published by PipelineRunner._publish_event is logged as
# a single JSON line via logging.getLogger("app.pipeline"). The JSONL file
# is the audit artifact for metrics analysis and ablation studies.
_pipeline_log_dir = Path("logs")
_pipeline_log_dir.mkdir(parents=True, exist_ok=True)
_pipeline_log_handler = logging.FileHandler(
    _pipeline_log_dir / "pipeline.jsonl", encoding="utf-8"
)
_pipeline_log_handler.setFormatter(logging.Formatter("%(message)s"))
logging.getLogger("app.pipeline").addHandler(_pipeline_log_handler)

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
        skill_catalog = SkillCatalog()
        model_settings_store = ModelSettingsStore(
            Path(configured.output_dir).expanduser().resolve().parent
            / "settings"
            / "model.json",
            defaults=configured,
        )
        set_current_model_settings_store(model_settings_store)
        model_preview_client = httpx.AsyncClient(
            timeout=10.0,
            follow_redirects=False,
            trust_env=False,
        )
        skill_store = UserSkillStore(
            configured.skill_data_path,
            catalog=skill_catalog,
            builtins=load_builtin_skill_descriptors(),
        )
        manager = TaskManager(
            repository,
            run_executor=ModeDispatchRunExecutor(
                repository,
                skill_catalog=skill_catalog,
            ),
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
        # Initialize the local queryable cache (D1/D3) — stores user-imported
        # and previously-cleaned datasets under data/cache/records/.
        application.state.cache_store = init_cache_store(
            Path(configured.output_dir).parent / "cache"
        )
        application.state.skill_catalog = skill_catalog
        application.state.skill_store = skill_store
        application.state.model_settings_store = model_settings_store
        application.state.model_preview_client = model_preview_client
        try:
            await manager.start()
            yield
        finally:
            try:
                await model_preview_client.aclose()
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
    application.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=["127.0.0.1", "localhost"],
    )
    application.include_router(routes_router)
    application.include_router(skills_router)
    application.include_router(settings_router)
    application.include_router(ws_router)
    application.add_api_route("/api/v1/health", health, methods=["GET"])
    return application


app = create_app()
