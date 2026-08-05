"""Model settings, vendor presets, and remote model discovery API."""

from __future__ import annotations

from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from app.model_config.catalog import get_known_model, guess_context_window
from app.model_config.context_budget import (
    ContextBudgetConfigurationError,
    resolve_context_budget,
)
from app.model_info.vendors import list_vendors as _list_vendor_dicts
from app.model_settings import ModelConfiguration, ModelSettingsStore, mask_api_key
from app.tools.network_safety import UnsafeUrlError, resolve_public_http_target

router = APIRouter(prefix="/api/v1", tags=["settings"])


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url: str | None = None
    api_key: str | None = None
    model_name: str | None = None
    max_tokens: int | None = None
    context_window: int | None = None
    safety_reserve_ratio: float | None = None
    compaction_trigger_ratio: float | None = None
    compaction_target_ratio: float | None = None
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
    context_window: int
    context_window_source: Literal["catalog", "user", "inferred", "unknown"]
    safety_reserve_ratio: float
    safety_reserve_tokens: int
    compaction_trigger_ratio: float
    compaction_target_ratio: float
    available_input_tokens: int
    run_ready: bool
    run_block_reason: str | None


class ModelPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str | None = None
    preview_base_url: str
    preview_api_key: str = ""


def _preview_api_key(
    body: ModelPreviewRequest,
    current: ModelConfiguration,
) -> str:
    if body.preview_api_key:
        return body.preview_api_key
    if body.preview_base_url.rstrip("/") == str(current.base_url).rstrip("/"):
        return current.api_key
    return ""


def get_store(request: Request) -> ModelSettingsStore:
    return request.app.state.model_settings_store


StoreDep = Annotated[ModelSettingsStore, Depends(get_store)]


def _public(value: ModelConfiguration) -> PublicSettings:
    try:
        budget = resolve_context_budget(value)
    except ContextBudgetConfigurationError as error:
        return PublicSettings(
            base_url=str(value.base_url).rstrip("/"),
            api_key=mask_api_key(value.api_key),
            api_key_configured=bool(value.api_key),
            model_name=value.model_name,
            max_tokens=value.max_tokens,
            advanced=value.advanced.model_dump(),
            context_window=0,
            context_window_source="unknown",
            safety_reserve_ratio=value.safety_reserve_ratio,
            safety_reserve_tokens=0,
            compaction_trigger_ratio=value.compaction_trigger_ratio,
            compaction_target_ratio=value.compaction_target_ratio,
            available_input_tokens=0,
            run_ready=False,
            run_block_reason=error.reason,
        )
    if value.context_window is not None:
        source: Literal["catalog", "user", "inferred", "unknown"] = "user"
    elif get_known_model(value.model_name) is not None:
        source = "catalog"
    else:
        source = "inferred"
    return PublicSettings(
        base_url=str(value.base_url).rstrip("/"),
        api_key=mask_api_key(value.api_key),
        api_key_configured=bool(value.api_key),
        model_name=value.model_name,
        max_tokens=value.max_tokens,
        advanced=value.advanced.model_dump(),
        context_window=budget.context_window,
        context_window_source=source,
        safety_reserve_ratio=value.safety_reserve_ratio,
        safety_reserve_tokens=budget.safety_reserve_tokens,
        compaction_trigger_ratio=value.compaction_trigger_ratio,
        compaction_target_ratio=value.compaction_target_ratio,
        available_input_tokens=budget.input_capacity,
        run_ready=True,
        run_block_reason=None,
    )


@router.get("/settings", response_model=PublicSettings)
async def get_settings(store: StoreDep) -> PublicSettings:
    return _public(store.snapshot())


@router.put("/settings", response_model=PublicSettings)
async def update_settings(body: SettingsUpdate, store: StoreDep) -> PublicSettings:
    # ── field-presence semantics ──────────────────────────────────────
    # model_dump(exclude_unset=True) keeps every explicitly-provided
    # field (even null); model_dump(exclude_none=True, exclude_unset=True)
    # keeps only explicitly-provided *non-null* fields.  Their set
    # difference reveals fields the caller explicitly sent as null
    # (intent: clear).  This is the foundation for distinguishing
    # "omit context_window" (leave override) from "null" (clear to catalog).
    set_fields = body.model_dump(exclude_unset=True)
    non_none = body.model_dump(exclude_none=True, exclude_unset=True)
    changes = dict(non_none)
    clears = {
        key
        for key, value in set_fields.items()
        if value is None and key not in changes
    }
    try:
        return _public(store.update(changes, clears=clears))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.get("/vendors")
async def list_vendors() -> dict[str, object]:
    return {"vendors": _list_vendor_dicts()}


@router.post("/models")
async def list_models(
    request: Request,
    store: StoreDep,
    body: ModelPreviewRequest,
) -> dict[str, object]:
    current = store.snapshot()
    base_url = body.preview_base_url
    api_key = _preview_api_key(body, current)
    try:
        target = resolve_public_http_target(base_url, require_https=bool(api_key))
    except UnsafeUrlError as error:
        raise HTTPException(
            status_code=422,
            detail=f"模型预览地址不可用：{error}",
        ) from error
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
        _model_preview_item(model_id, current)
        for model_id in model_ids
        if isinstance(model_id, str)
        and (body.query is None or body.query.lower() in model_id.lower())
    ]
    return {"models": models, "total_count": len(models), "api_source": base_url}


def _infer_suggested_max_tokens(model_id: str) -> int:
    ml = model_id.lower()
    if ml.startswith("deepseek"):
        return 8_192
    if ml.startswith("qwq") or ml.startswith("qwen"):
        return 8_192
    if ml.startswith("gpt-4") or ml.startswith("gpt4"):
        return 4_096
    return 4_096


def _model_preview_item(
    model_id: str, current: ModelConfiguration
) -> dict[str, object]:
    """Build a model preview entry using catalog metadata when available."""
    known = get_known_model(model_id)
    if known is not None:
        return {
            "id": model_id,
            "name": known.name,
            "description": known.description,
            "context_window": known.context_window,
            "suggested_max_tokens": known.suggested_max_tokens,
            "capabilities": known.capabilities.model_dump(),
            "recommended": model_id == current.model_name,
            "api_available": True,
            "capability_source": "catalog",
        }
    return {
        "id": model_id,
        "name": model_id,
        "description": "API discovered model",
        "context_window": guess_context_window(model_id),
        "suggested_max_tokens": _infer_suggested_max_tokens(model_id),
        "capabilities": {"text": True, "image": False, "video": False, "audio": False},
        "recommended": model_id == current.model_name,
        "api_available": True,
        "capability_source": "api",
    }
