"""Model settings, vendor presets, and remote model discovery API."""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from app.model_settings import ModelConfiguration, ModelSettingsStore, mask_api_key
from app.tools.network_safety import UnsafeUrlError, resolve_public_http_target

router = APIRouter(prefix="/api/v1", tags=["settings"])


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url: str | None = None
    api_key: str | None = None
    model_name: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    repetition_penalty: float | None = None
    enable_search: bool | None = None
    thinking_mode: bool | None = None


class PublicSettings(BaseModel):
    base_url: str
    api_key: str
    api_key_configured: bool
    model_name: str
    max_tokens: int
    advanced: dict[str, Any]


class ModelPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str | None = None
    preview_base_url: str
    preview_api_key: str = ""


VENDORS = (
    {
        "id": "dashscope",
        "name": "DashScope",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "description": "阿里云 Qwen 官方 API",
        "recommended": True,
    },
    {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "description": "OpenAI 官方 API",
        "recommended": False,
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "description": "DeepSeek 官方 API",
        "recommended": False,
    },
)


def get_store(request: Request) -> ModelSettingsStore:
    return request.app.state.model_settings_store


StoreDep = Annotated[ModelSettingsStore, Depends(get_store)]


def _public(value: ModelConfiguration) -> PublicSettings:
    return PublicSettings(
        base_url=str(value.base_url).rstrip("/"),
        api_key=mask_api_key(value.api_key),
        api_key_configured=bool(value.api_key),
        model_name=value.model_name,
        max_tokens=value.max_tokens,
        advanced=value.advanced.model_dump(),
    )


@router.get("/settings", response_model=PublicSettings)
async def get_settings(store: StoreDep) -> PublicSettings:
    return _public(store.snapshot())


@router.put("/settings", response_model=PublicSettings)
async def update_settings(body: SettingsUpdate, store: StoreDep) -> PublicSettings:
    changes = body.model_dump(exclude_none=True)
    try:
        return _public(store.update(changes))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get("/vendors")
async def list_vendors() -> dict[str, object]:
    return {"vendors": VENDORS}


@router.post("/models")
async def list_models(
    request: Request,
    store: StoreDep,
    body: ModelPreviewRequest,
) -> dict[str, object]:
    current = store.snapshot()
    base_url = body.preview_base_url
    api_key = body.preview_api_key or current.api_key
    try:
        target = resolve_public_http_target(base_url, require_https=bool(api_key))
    except UnsafeUrlError as error:
        raise HTTPException(status_code=422, detail="Model preview URL is not allowed") from error
    headers = {"Host": target.host_header}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        outbound = request.app.state.model_preview_client.build_request(
            "GET",
            f"{target.connect_url.rstrip('/')}/models",
            headers=headers,
            extensions={"sni_hostname": target.sni_hostname},
        )
        response = await request.app.state.model_preview_client.send(
            outbound, follow_redirects=False
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("model preview response must be an object")
        raw_models = data.get("data")
        if not isinstance(raw_models, list):
            raise ValueError("model preview response data must be a list")
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(status_code=502, detail="Model preview failed") from error
    model_ids = [item.get("id") for item in raw_models if isinstance(item, dict)]
    models = [
        {
            "id": model_id,
            "name": model_id,
            "description": "API discovered model",
            "context_window": 0,
            "suggested_max_tokens": current.max_tokens,
            "capabilities": {"text": True, "image": False, "video": False, "audio": False},
            "recommended": model_id == current.model_name,
            "api_available": True,
            "capability_source": "api",
        }
        for model_id in model_ids
        if isinstance(model_id, str)
        and (body.query is None or body.query.lower() in model_id.lower())
    ]
    return {"models": models, "total_count": len(models), "api_source": base_url}
