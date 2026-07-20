from __future__ import annotations

import app.api.settings_router as settings_router
import pytest
from app.api.settings_router import UpdateSettingsRequest
from app.model_config import UserSettings


@pytest.mark.asyncio
async def test_post_settings_preserves_key_when_client_returns_mask(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = UserSettings(api_key="sk-secret-value-1234")
    captured: list[UserSettings] = []
    monkeypatch.setattr(settings_router, "get_settings", lambda: current)
    monkeypatch.setattr(
        settings_router,
        "update_settings",
        lambda value: captured.append(value) or value,
    )

    await settings_router.post_settings(
        UpdateSettingsRequest(api_key=settings_router._mask_key(current.api_key))
    )

    assert captured == [current]


@pytest.mark.asyncio
async def test_post_settings_replaces_key_with_new_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = UserSettings(api_key="sk-old-value-1234")
    captured: list[UserSettings] = []
    monkeypatch.setattr(settings_router, "get_settings", lambda: current)
    monkeypatch.setattr(
        settings_router,
        "update_settings",
        lambda value: captured.append(value) or value,
    )

    await settings_router.post_settings(
        UpdateSettingsRequest(api_key="sk-new-value-5678")
    )

    assert captured[0].api_key == "sk-new-value-5678"


@pytest.mark.asyncio
async def test_settings_response_masks_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = UserSettings(api_key="sk-secret-value-1234")
    monkeypatch.setattr(settings_router, "get_settings", lambda: current)

    response = await settings_router.get_settings_endpoint()

    assert response.api_key == "sk-secre...1234"
    assert response.api_key != current.api_key


def test_vendors_route_is_registered_once() -> None:
    vendor_routes = [
        route
        for route in settings_router.router.routes
        if getattr(route, "path", None) == "/api/v1/vendors"
        and "GET" in getattr(route, "methods", set())
    ]

    assert len(vendor_routes) == 1
