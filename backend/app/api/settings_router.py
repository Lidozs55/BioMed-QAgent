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

from app.model_config.models import (
    AdvancedParams,
    QwenModelEntry,
    UserSettings,
    list_vendors,
    infer_capabilities,
    list_known_models,
    get_advanced_defaults,
)
from app.settings_manager import (
    get_settings,
    update_settings,
    get_model_entry,
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
    temperature: float | None = None
    top_p: float | None = None
    repetition_penalty: float | None = None
    enable_search: bool | None = None
    thinking_mode: bool | None = None


class SettingsResponse(BaseModel):
    base_url: str
    api_key: str
    model_name: str
    max_tokens: int
    temperature: float
    top_p: float
    repetition_penalty: float
    enable_search: bool
    thinking_mode: bool


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
    capability_source: str = "builtin"
    capability_source: str = "builtin"


class VendorResponse(BaseModel):
    id: str; name: str; base_url: str; description: str
    recommended: bool = False


class VendorResponse(BaseModel):
    id: str; name: str; base_url: str; description: str
    recommended: bool = False


class ModelListResponse(BaseModel):
    models: list[AvailableModelEntry]
    total_count: int
    api_source: str | None




@router.get("/vendors", response_model=list[VendorResponse])
async def get_vendors_endpoint() -> list[VendorResponse]:
    return [VendorResponse(**v) for v in list_vendors()]


@router.get("/vendors", response_model=list[VendorResponse])
async def get_vendors_endpoint() -> list[VendorResponse]:
    return [VendorResponse(**v) for v in list_vendors()]
@router.get("/settings", response_model=SettingsResponse)
async def get_settings_endpoint() -> SettingsResponse:
    settings = get_settings()
    return SettingsResponse(
        base_url=settings.base_url,
        api_key=_mask_key(settings.api_key),
        model_name=settings.model_name,
        max_tokens=settings.max_tokens,
        temperature=settings.advanced.temperature,
        top_p=settings.advanced.top_p,
        repetition_penalty=settings.advanced.repetition_penalty,
        enable_search=settings.advanced.enable_search,
        thinking_mode=settings.advanced.thinking_mode,
    )


@router.post("/settings", response_model=SettingsResponse)
async def post_settings(body: UpdateSettingsRequest) -> SettingsResponse:
    current = get_settings()
    adv = current.advanced
    merged = UserSettings(
        base_url=body.base_url if body.base_url is not None else current.base_url,
        api_key=body.api_key if body.api_key is not None else current.api_key,
        model_name=body.model_name if body.model_name is not None else current.model_name,
        max_tokens=body.max_tokens if body.max_tokens is not None else current.max_tokens,
        advanced=AdvancedParams(
            temperature=body.temperature if body.temperature is not None else adv.temperature,
            top_p=body.top_p if body.top_p is not None else adv.top_p,
            repetition_penalty=body.repetition_penalty if body.repetition_penalty is not None else adv.repetition_penalty,
            enable_search=body.enable_search if body.enable_search is not None else adv.enable_search,
            thinking_mode=body.thinking_mode if body.thinking_mode is not None else adv.thinking_mode,
        ),
    )
    result = update_settings(merged)
    return SettingsResponse(
        base_url=result.base_url,
        api_key=_mask_key(result.api_key),
        model_name=result.model_name,
        max_tokens=result.max_tokens,
        temperature=result.advanced.temperature,
        top_p=result.advanced.top_p,
        repetition_penalty=result.advanced.repetition_penalty,
        enable_search=result.advanced.enable_search,
        thinking_mode=result.advanced.thinking_mode,
    )


@router.get("/models", response_model=ModelListResponse)
async def list_models(
    query: Annotated[str | None, Query(description="Search filter")] = None,
    preview_base_url: Annotated[str | None, Query(description="Preview base URL")] = None,
    preview_api_key: Annotated[str | None, Query(description="Preview API key")] = None,
    use_current_settings: Annotated[bool, Query(description="Ignore preview params and use saved settings")] = False,
) -> ModelListResponse:
    settings = get_settings()
    if use_current_settings:
        use_base = settings.base_url
        use_key = settings.api_key
    else:
        use_base = preview_base_url if preview_base_url is not None else ""
        use_key = preview_api_key if preview_api_key is not None else ""
    api_source: str | None = None
    api_model_ids: set[str] = set()

    if use_base and use_key:
        try:
            remote_ids = await _fetch_remote_model_ids(use_base, use_key)
            api_model_ids.update(remote_ids)
            api_source = use_base
        except Exception as exc:
            logger.warning("Failed to fetch remote model list: %s", exc)

    result: list[AvailableModelEntry] = []
    if api_source:
        known_db = {m.id: m for m in list_known_models()}
        for mid in sorted(api_model_ids):
            if query is not None and query.lower() not in mid.lower():
                continue
            entry = known_db.get(mid)
            if entry:
                result.append(
                    AvailableModelEntry(
                        id=entry.id, name=entry.name,
                        description=entry.description,
                        context_window=entry.context_window,
                        suggested_max_tokens=entry.suggested_max_tokens,
                        capabilities=entry.capabilities.model_dump(),
                        recommended=entry.recommended,
                        api_available=True,
                    )
                )
            else:
                inferred = infer_capabilities(mid)
                # Use model-family-specific defaults for API-discovered models
                ml = mid.lower()
                if ml.startswith("deepseek"):
                    cw, smt = 1_000_000, 8_192
                elif "qwen" in ml:
                    cw, smt = 128_000, 8_192
                else:
                    cw, smt = 32_768, 4_096
                result.append(
                   AvailableModelEntry(
                       id=mid, name=mid,
                       description="通过 API 发现的模型",
                        context_window=cw,
                        suggested_max_tokens=smt,
                       capabilities=inferred.model_dump() if inferred else {"text": True, "image": False, "video": False, "audio": False},
                        recommended=False,
                        api_available=True,
                        capability_source="api",
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
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        resp = await client.get(url, headers=headers,)
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
