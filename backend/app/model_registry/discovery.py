"""Remote model discovery for configured providers (OpenAI-compatible)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import httpx

from app.model_config.catalog import get_known_model, guess_context_window
from app.model_registry.schemas import (
    Capabilities,
    DiscoveredModel,
    ParameterSpec,
)
from app.tools.network_safety import resolve_public_http_target

HttpSend = Callable[[httpx.Request], Awaitable[httpx.Response]]


def _infer_suggested_max_tokens(model_id: str) -> int:
    """Guess a safe default output cap for an unknown model id."""

    lowered = model_id.lower()
    if lowered.startswith(("deepseek", "qwq", "qwen")):
        return 8_192
    return 4_096


def _catalog_capabilities(known: object) -> Capabilities:
    capabilities = getattr(known, "capabilities", None)
    return Capabilities(
        text=bool(getattr(capabilities, "text", True)),
        image=bool(getattr(capabilities, "image", False)),
        video=bool(getattr(capabilities, "video", False)),
        audio=bool(getattr(capabilities, "audio", False)),
    )


def enrich_discovered_model(
    model_id: str,
    param_specs: list[ParameterSpec],
) -> DiscoveredModel:
    """Build a discovered-model view, preferring catalog metadata when known."""

    known = get_known_model(model_id)
    if known is not None:
        return DiscoveredModel(
            id=model_id,
            name=known.name,
            description=known.description,
            context_window=known.context_window,
            max_output_tokens=known.suggested_max_tokens,
            suggested_max_tokens=known.suggested_max_tokens,
            capabilities=_catalog_capabilities(known),
            recommended=known.recommended,
            param_specs=param_specs,
            capability_source="catalog",
        )
    return DiscoveredModel(
        id=model_id,
        name=model_id,
        description="API 发现的模型",
        context_window=guess_context_window(model_id),
        max_output_tokens=_infer_suggested_max_tokens(model_id),
        suggested_max_tokens=_infer_suggested_max_tokens(model_id),
        param_specs=param_specs,
        capability_source="api",
    )


async def discover_provider_models(
    base_url: str,
    api_key: str,
    send: HttpSend,
    param_specs: list[ParameterSpec],
) -> list[DiscoveredModel]:
    """Fetch ``GET /models`` from an OpenAI-compatible provider and enrich it.

    Extra or unknown fields returned by the provider are ignored instead of
    rejected, so new providers keep working without backend changes.
    """

    target = resolve_public_http_target(base_url, require_https=bool(api_key))
    headers = {"Host": target.host_header}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = httpx.Request(
        "GET",
        f"{target.connect_url.rstrip('/')}/models",
        headers=headers,
    )
    request.extensions["sni_hostname"] = target.sni_hostname
    response = await send(request)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("model discovery response must be an object")
    raw_models = payload.get("data")
    if not isinstance(raw_models, list):
        raise ValueError("model discovery response data must be a list")
    discovered: list[DiscoveredModel] = []
    seen: set[str] = set()
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str) or not model_id or model_id in seen:
            continue
        seen.add(model_id)
        discovered.append(enrich_discovered_model(model_id, param_specs))
    return discovered


__all__ = ["HttpSend", "discover_provider_models", "enrich_discovered_model"]
