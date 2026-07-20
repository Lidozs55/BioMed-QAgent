from __future__ import annotations

import app.api.settings_router as settings_router
import httpx
import pytest
from app.model_config import UserSettings
from app.tools.network_safety import UnsafeUrlError, validate_public_http_url
from fastapi import FastAPI


@pytest.fixture
def application() -> FastAPI:
    application = FastAPI()
    application.include_router(settings_router.router)
    return application


def _api_client(application: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application, raise_app_exceptions=False),
        base_url="http://testserver",
    )


def _set_current_settings(
    monkeypatch: pytest.MonkeyPatch,
    settings: UserSettings,
) -> None:
    monkeypatch.setattr(settings_router, "get_settings", lambda: settings)


@pytest.mark.asyncio
async def test_models_ignores_preview_api_key_and_uses_public_preview_without_credentials(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"data": [{"id": "public-model"}]}, request=request)

    _set_current_settings(
        monkeypatch,
        UserSettings(base_url="https://saved.example/v1", api_key="saved-secret"),
    )
    monkeypatch.setattr(settings_router, "validate_public_http_url", lambda url: url)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ) as remote_client:
        monkeypatch.setattr(settings_router, "_get_http_client", lambda: remote_client)
        async with _api_client(application) as api_client:
            response = await api_client.get(
                "/api/v1/models",
                params={
                    "preview_base_url": "https://catalog.example/v1",
                    "preview_api_key": "attacker-controlled-secret",
                },
            )

    assert response.status_code == 200
    assert response.json()["models"][0]["id"] == "public-model"
    assert len(requests) == 1
    assert requests[0].url == "https://catalog.example/v1/models"
    assert "authorization" not in requests[0].headers


def test_models_route_does_not_define_preview_api_key_parameter(application: FastAPI) -> None:
    parameters = application.openapi()["paths"]["/api/v1/models"]["get"]["parameters"]

    assert all(parameter["name"] != "preview_api_key" for parameter in parameters)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "base_url",
    [
        "http://localhost:8000",
        "https://user:password@provider.example/v1",
        "https://[invalid",
    ],
)
async def test_models_rejects_unsafe_saved_provider_destination(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    base_url: str,
) -> None:
    _set_current_settings(monkeypatch, UserSettings(base_url=base_url, api_key="saved-secret"))

    async with _api_client(application) as api_client:
        response = await api_client.get("/api/v1/models", params={"use_current_settings": "true"})

    assert response.status_code == 422
    assert "saved-secret" not in response.text
    assert base_url not in response.text


def test_public_url_validator_rejects_malformed_url() -> None:
    with pytest.raises(UnsafeUrlError):
        validate_public_http_url("https://[invalid")


@pytest.mark.asyncio
async def test_models_rejects_http_when_saved_key_would_be_attached(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_current_settings(
        monkeypatch,
        UserSettings(base_url="http://8.8.8.8/v1", api_key="saved-secret"),
    )

    async with _api_client(application) as api_client:
        response = await api_client.get("/api/v1/models", params={"use_current_settings": "true"})

    assert response.status_code == 422
    assert "saved-secret" not in response.text


@pytest.mark.asyncio
async def test_models_discovers_saved_provider_models_over_https(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"data": [{"id": "qwen-plus"}]}, request=request)

    _set_current_settings(
        monkeypatch,
        UserSettings(base_url="https://provider.example/v1", api_key="saved-secret"),
    )
    monkeypatch.setattr(settings_router, "validate_credentialed_public_url", lambda url: url)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ) as remote_client:
        monkeypatch.setattr(settings_router, "_get_http_client", lambda: remote_client)
        async with _api_client(application) as api_client:
            response = await api_client.get(
                "/api/v1/models", params={"use_current_settings": "true"}
            )

    assert response.status_code == 200
    assert response.json()["models"][0]["id"] == "qwen-plus"
    assert requests[0].url == "https://provider.example/v1/models"
    assert requests[0].headers["authorization"] == "Bearer saved-secret"


@pytest.mark.asyncio
async def test_models_refuses_redirect_without_forwarding_saved_credentials(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            302,
            headers={"location": "https://redirect.example/models"},
            request=request,
        )

    _set_current_settings(
        monkeypatch,
        UserSettings(base_url="https://provider.example/v1", api_key="saved-secret"),
    )
    monkeypatch.setattr(settings_router, "validate_credentialed_public_url", lambda url: url)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ) as remote_client:
        monkeypatch.setattr(settings_router, "_get_http_client", lambda: remote_client)
        async with _api_client(application) as api_client:
            response = await api_client.get(
                "/api/v1/models", params={"use_current_settings": "true"}
            )

    assert response.status_code == 502
    assert len(requests) == 1
    assert requests[0].headers["authorization"] == "Bearer saved-secret"
    assert "saved-secret" not in response.text
    assert "redirect.example" not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "content"),
    [
        ("provider_status", b'{"error":"saved-secret upstream response"}'),
        ("invalid_json", b"not valid json"),
        ("timeout", b""),
        ("connection", b""),
    ],
)
async def test_models_returns_sanitized_gateway_error_for_provider_failures(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
    content: bytes,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if failure == "timeout":
            raise httpx.ReadTimeout("saved-secret", request=request)
        if failure == "connection":
            raise httpx.ConnectError("saved-secret", request=request)
        status_code = 500 if failure == "provider_status" else 200
        return httpx.Response(status_code, content=content, request=request)

    _set_current_settings(
        monkeypatch,
        UserSettings(base_url="https://provider.example/v1", api_key="saved-secret"),
    )
    monkeypatch.setattr(settings_router, "validate_credentialed_public_url", lambda url: url)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ) as remote_client:
        monkeypatch.setattr(settings_router, "_get_http_client", lambda: remote_client)
        async with _api_client(application) as api_client:
            response = await api_client.get(
                "/api/v1/models", params={"use_current_settings": "true"}
            )

    assert response.status_code == 502
    assert response.json() == {"detail": "Model provider discovery failed"}
    assert "saved-secret" not in response.text
    assert "upstream response" not in response.text


@pytest.mark.asyncio
async def test_post_settings_preserves_key_for_omitted_none_or_masked_value(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = UserSettings(api_key="sk-secret-value-1234")
    captured: list[UserSettings] = []
    _set_current_settings(monkeypatch, current)
    monkeypatch.setattr(
        settings_router,
        "update_settings",
        lambda value: captured.append(value) or value,
    )

    async with _api_client(application) as api_client:
        omitted = await api_client.post("/api/v1/settings", json={})
        null = await api_client.post("/api/v1/settings", json={"api_key": None})
        masked = await api_client.post(
            "/api/v1/settings",
            json={"api_key": "sk-s...1234"},
        )

    assert omitted.status_code == 200
    assert null.status_code == 200
    assert masked.status_code == 200
    assert [settings.api_key for settings in captured] == [current.api_key] * 3


@pytest.mark.asyncio
async def test_post_settings_clears_key_for_empty_string(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = UserSettings(api_key="sk-secret-value-1234")
    captured: list[UserSettings] = []
    _set_current_settings(monkeypatch, current)
    monkeypatch.setattr(
        settings_router,
        "update_settings",
        lambda value: captured.append(value) or value,
    )

    async with _api_client(application) as api_client:
        response = await api_client.post("/api/v1/settings", json={"api_key": ""})

    assert response.status_code == 200
    assert captured[0].api_key == ""
    assert response.json()["api_key"] == ""


@pytest.mark.asyncio
async def test_post_settings_replaces_key_with_new_secret(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = UserSettings(api_key="sk-old-value-1234")
    captured: list[UserSettings] = []
    _set_current_settings(monkeypatch, current)
    monkeypatch.setattr(
        settings_router,
        "update_settings",
        lambda value: captured.append(value) or value,
    )

    async with _api_client(application) as api_client:
        response = await api_client.post(
            "/api/v1/settings", json={"api_key": "sk-new-value-5678"}
        )

    assert response.status_code == 200
    assert captured[0].api_key == "sk-new-value-5678"
    assert response.json()["api_key"] == "sk-n...5678"


@pytest.mark.asyncio
async def test_settings_response_masks_api_key(
    application: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = UserSettings(api_key="sk-secret-value-1234")
    _set_current_settings(monkeypatch, current)

    async with _api_client(application) as api_client:
        response = await api_client.get("/api/v1/settings")

    assert response.status_code == 200
    assert response.json()["api_key"] == "sk-s...1234"
    assert response.json()["api_key"] != current.api_key


@pytest.mark.parametrize(
    ("key", "masked"),
    [
        ("", ""),
        ("short-secret", "****"),
        ("exactlytwelv", "****"),
        ("sk-secret-value-1234", "sk-s...1234"),
    ],
)
def test_mask_key_matches_locked_contract(key: str, masked: str) -> None:
    assert settings_router._mask_key(key) == masked


def test_vendors_route_is_registered_once() -> None:
    vendor_routes = [
        route
        for route in settings_router.router.routes
        if getattr(route, "path", None) == "/api/v1/vendors"
        and "GET" in getattr(route, "methods", set())
    ]

    assert len(vendor_routes) == 1
