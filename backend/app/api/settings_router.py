"""Settings REST API — user model configuration and model listing.

Endpoints:
    GET  /api/v1/settings              → current user model settings (api_key masked)
    POST /api/v1/settings              → update and persist user settings
    GET  /api/v1/models                → available model list with capability info
    GET  /api/v1/models/{model_id}     → single model detail
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from httpx import AsyncClient, HTTPError, TimeoutException
from pydantic import BaseModel

from app.settings_manager import (
    QwenModelEntry,
    UserSettings,
    get_model_entry,
    get_settings,
    list_known_models,
    update_settings,
)

router = APIRouter(prefix="/api/v1")
logger = logging.getLogger(__name__)

_httpx_client: AsyncClient | None = None


def _get_http_client() -> AsyncClient:
    global _httpx_client
    if _httpx_client is None:
        _httpx_client = AsyncClient(timeout=10.0, follow_redirects=True)
    return _httpx_client


class UpdateSettingsRequest(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    model_name: str | None = None
    max_tokens: int | None = None


class SettingsResponse(BaseModel):
    base_url: str
    api_key: str
    model_name: str
    max_tokens: int


class ModelInfoResponse(BaseModel):
    id: str
    name: str
    description: str
    context_window: int
    suggested_max_tokens: int
    capabilities: dict[str, bool]
    recommended: bool


class AvailableModelEntry(BaseModel):
    id: str
    name: str
    description: str
    context_window: int
    suggested_max_tokens: int
    capabilities: dict[str, bool]
    recommended: bool
    api_available: bool = False


class ModelListResponse(BaseModel):
    models: list[AvailableModelEntry]
    total_count: int
    api_source: str | None


@router.get("/settings", response_model=SettingsResponse)
async def get_settings_endpoint() -> SettingsResponse:
    settings = get_settings()
    return SettingsResponse(
        base_url=settings.base_url,
        api_key=_mask_key(settings.api_key),
        model_name=settings.model_name,
        max_tokens=settings.max_tokens,
    )


@router.post("/settings", response_model=SettingsResponse)
async def post_settings(body: UpdateSettingsRequest) -> SettingsResponse:
    current = get_settings()
    merged = UserSettings(
        base_url=body.base_url if body.base_url is not None else current.base_url,
        api_key=body.api_key if body.api_key is not None else current.api_key,
        model_name=body.model_name if body.model_name is not None else current.model_name,
        max_tokens=body.max_tokens if body.max_tokens is not None else current.max_tokens,
    )
    result = update_settings(merged)
    return SettingsResponse(
        base_url=result.base_url,
        api_key=_mask_key(result.api_key),
        model_name=result.model_name,
        max_tokens=result.max_tokens,
    )


@router.get("/models", response_model=ModelListResponse)
async def list_models(
    query: Annotated[str | None, Query(description="Search filter")] = None,
) -> ModelListResponse:
    settings = get_settings()
    api_source: str | None = None
    api_model_ids: set[str] = set()

    if settings.base_url and settings.api_key:
        try:
            remote_ids = await _fetch_remote_model_ids(settings.base_url, settings.api_key)
            api_model_ids.update(remote_ids)
            api_source = settings.base_url
        except Exception as exc:
            logger.warning("Failed to fetch remote model list: %s", exc)

    known = list_known_models()
    result: list[AvailableModelEntry] = []
    for entry in known:
        if query is not None and query.lower() not in entry.name.lower():
            continue
        result.append(
            AvailableModelEntry(
                id=entry.id,
                name=entry.name,
                description=entry.description,
                context_window=entry.context_window,
                suggested_max_tokens=entry.suggested_max_tokens,
                capabilities=entry.capabilities.model_dump(),
                recommended=entry.recommended,
                api_available=entry.id in api_model_ids,
            )
        )

    return ModelListResponse(
        models=result,
        total_count=len(result),
        api_source=api_source,
    )


@router.get("/models/{model_id}", response_model=ModelInfoResponse)
async def get_model_detail(model_id: str) -> ModelInfoResponse:
    entry = get_model_entry(model_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found")
    return ModelInfoResponse(
        id=entry.id,
        name=entry.name,
        description=entry.description,
        context_window=entry.context_window,
        suggested_max_tokens=entry.suggested_max_tokens,
        capabilities=entry.capabilities.model_dump(),
        recommended=entry.recommended,
    )


def _mask_key(key: str) -> str:
    if len(key) <= 12:
        return key[:4] + "****" if key else ""
    return key[:8] + "..." + key[-4:]


async def _fetch_remote_model_ids(base_url: str, api_key: str) -> set[str]:
    url = base_url.rstrip("/") + "/models"
    client = _get_http_client()
    try:
        resp = await client.get(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
        )
        resp.raise_for_status()
        data = resp.json()
        ids: set[str] = set()
        for item in data.get("data", []):
            mid = item.get("id")
            if mid and isinstance(mid, str):
                ids.add(mid)
        logger.info("Fetched %d model IDs from %s", len(ids), base_url)
        return ids
    except (HTTPError, TimeoutException, ValueError, KeyError) as exc:
        logger.warning("Failed to query %s/models: %s", base_url, exc)
        return set()


async def shutdown_http_client() -> None:
    global _httpx_client
    if _httpx_client is not None:
        await _httpx_client.aclose()
        _httpx_client = None
