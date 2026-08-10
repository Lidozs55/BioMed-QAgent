"""Provider and managed-model management API."""

from __future__ import annotations

from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from app.api.settings import (
    PublicSettings,
    _public,
)
from app.api.settings import (
    get_store as get_settings_store,
)
from app.model_registry.discovery import discover_provider_models
from app.model_registry.schemas import (
    DiscoveredModel,
    ManagedModelCreate,
    ManagedModelPublic,
    ManagedModelRecord,
    ManagedModelUpdate,
    ParameterSpec,
    ProviderCreate,
    ProviderPublic,
    ProviderRecord,
    ProviderUpdate,
)
from app.model_registry.store import ProviderModelStore
from app.model_settings import ModelSettingsStore, mask_api_key
from app.tools.network_safety import UnsafeUrlError

router = APIRouter(prefix="/api/v1/model-registry", tags=["model_registry"])


def get_store(request: Request) -> ProviderModelStore:
    return request.app.state.provider_model_store


StoreDep = Annotated[ProviderModelStore, Depends(get_store)]
SettingsStoreDep = Annotated[ModelSettingsStore, Depends(get_settings_store)]


def _provider_public(record: ProviderRecord) -> ProviderPublic:
    return ProviderPublic(
        id=record.id,
        name=record.name,
        base_url=record.base_url,
        api_key=mask_api_key(record.api_key),
        api_key_configured=bool(record.api_key),
        preset_id=record.preset_id,
        description=record.description,
        enabled=record.enabled,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _model_public(
    record: ManagedModelRecord,
    provider: ProviderRecord,
) -> ManagedModelPublic:
    return ManagedModelPublic(
        id=record.id,
        provider_id=record.provider_id,
        provider_name=provider.name,
        provider_base_url=provider.base_url,
        provider_api_key_configured=bool(provider.api_key),
        model_id=record.model_id,
        name=record.name,
        description=record.description,
        context_window=record.context_window,
        max_output_tokens=record.max_output_tokens,
        suggested_max_tokens=record.suggested_max_tokens,
        capabilities=record.capabilities,
        params=record.params,
        param_specs=record.param_specs,
        source=record.source,
        active=record.active,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


# ----------------------------------------------------------------------
# Providers
# ----------------------------------------------------------------------


@router.get("/providers", response_model=list[ProviderPublic])
def list_providers(store: StoreDep) -> list[ProviderPublic]:
    return [_provider_public(record) for record in store.list_providers()]


@router.post("/providers", response_model=ProviderPublic, status_code=201)
def create_provider(body: ProviderCreate, store: StoreDep) -> ProviderPublic:
    try:
        record = store.create_provider(body)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return _provider_public(record)


@router.put("/providers/{provider_id}", response_model=ProviderPublic)
def update_provider(
    provider_id: str,
    body: ProviderUpdate,
    store: StoreDep,
) -> ProviderPublic:
    try:
        record = store.update_provider(provider_id, body)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if record is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    return _provider_public(record)


@router.delete("/providers/{provider_id}", status_code=204)
def delete_provider(provider_id: str, store: StoreDep) -> None:
    if not store.delete_provider(provider_id):
        raise HTTPException(status_code=404, detail="供应商不存在")


@router.post(
    "/providers/{provider_id}/discover",
    response_model=list[DiscoveredModel],
)
async def discover_models(
    provider_id: str,
    request: Request,
    store: StoreDep,
) -> list[DiscoveredModel]:
    """Fetch the provider's model list and enrich it with catalog metadata."""

    provider = store.get_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    if not provider.enabled:
        raise HTTPException(status_code=409, detail="供应商已停用")
    param_specs = store.get_param_specs(provider.preset_id or provider.name, "")
    try:
        return await discover_provider_models(
            provider.base_url,
            provider.api_key,
            request.app.state.model_preview_client.send,
            param_specs,
        )
    except UnsafeUrlError as error:
        raise HTTPException(status_code=422, detail=f"供应商 Base URL 不可用：{error}") from error
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(status_code=502, detail="模型发现失败") from error


@router.get(
    "/providers/{provider_id}/param-specs",
    response_model=list[ParameterSpec],
)
def provider_param_specs(provider_id: str, store: StoreDep) -> list[ParameterSpec]:
    """Return the provider's selectable parameter definitions (with fallback)."""

    provider = store.get_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    return store.get_param_specs(provider.preset_id or provider.name, "")


# ----------------------------------------------------------------------
# Managed models
# ----------------------------------------------------------------------


@router.get("/models", response_model=list[ManagedModelPublic])
def list_models(store: StoreDep) -> list[ManagedModelPublic]:
    return [
        _model_public(record, provider)
        for record, provider in store.list_models_with_provider()
    ]


@router.post("/models", response_model=ManagedModelPublic, status_code=201)
def create_model(body: ManagedModelCreate, store: StoreDep) -> ManagedModelPublic:
    try:
        record = store.create_model(body)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    provider = store.get_provider(record.provider_id)
    if provider is None:  # pragma: no cover - foreign key guarantees presence
        raise HTTPException(status_code=404, detail="供应商不存在")
    return _model_public(record, provider)


@router.put("/models/{model_id}", response_model=ManagedModelPublic)
def update_model(
    model_id: str,
    body: ManagedModelUpdate,
    store: StoreDep,
) -> ManagedModelPublic:
    record = store.update_model(model_id, body)
    if record is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    provider = store.get_provider(record.provider_id)
    if provider is None:  # pragma: no cover - foreign key guarantees presence
        raise HTTPException(status_code=404, detail="供应商不存在")
    return _model_public(record, provider)


@router.delete("/models/{model_id}", status_code=204)
def delete_model(model_id: str, store: StoreDep) -> None:
    if not store.delete_model(model_id):
        raise HTTPException(status_code=404, detail="模型不存在")


@router.post("/models/{model_id}/activate", response_model=PublicSettings)
async def activate_model(
    model_id: str,
    request: Request,
    store: StoreDep,
    settings_store: SettingsStoreDep,
) -> PublicSettings:
    """Activate a managed model and write it back into the runtime settings."""

    model = store.get_model(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    provider = store.get_provider(model.provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    changes: dict[str, object] = {
        "base_url": provider.base_url,
        "api_key": provider.api_key,
        "model_name": model.model_id,
    }
    if model.context_window is not None:
        changes["context_window"] = model.context_window
    param_max_tokens = model.params.get("max_tokens")
    if isinstance(param_max_tokens, (int, float)):
        changes["max_tokens"] = int(param_max_tokens)
    elif model.suggested_max_tokens is not None:
        changes["max_tokens"] = model.suggested_max_tokens
    for key in ("temperature", "top_p", "repetition_penalty"):
        if isinstance(model.params.get(key), (int, float)):
            changes[key] = model.params[key]
    for key in ("enable_search", "thinking_mode"):
        if isinstance(model.params.get(key), bool):
            changes[key] = model.params[key]
    try:
        updated = settings_store.update(changes)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    store.set_active_model(model_id)
    return _public(updated)
