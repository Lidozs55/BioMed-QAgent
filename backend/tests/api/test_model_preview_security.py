from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.api import settings as settings_api
from app.config import Settings
from app.main import create_app
from app.tools.network_safety import PublicHttpTarget


def _target(_: str, *, require_https: bool) -> PublicHttpTarget:
    assert require_https is True
    return PublicHttpTarget(
        connect_url="https://8.8.8.8/v1",
        host_header="models.provider.example",
        sni_hostname="models.provider.example",
    )


@pytest.mark.asyncio
async def test_model_preview_connects_to_validated_ip_with_original_host_and_sni(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"data": [{"id": "preview-model"}]})

    monkeypatch.setattr(settings_api, "resolve_public_http_target", _target)
    async with application.router.lifespan_context(application):
        await application.state.model_preview_client.aclose()
        application.state.model_preview_client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://localhost"
        ) as client:
            response = await client.post(
                "/api/v1/models",
                json={
                    "preview_base_url": "https://models.provider.example/v1",
                    "preview_api_key": "test-token",
                },
            )

    assert response.status_code == 200
    assert response.json()["models"][0]["id"] == "preview-model"
    assert str(requests[0].url) == "https://8.8.8.8/v1/models"
    assert requests[0].headers["host"] == "models.provider.example"
    assert requests[0].extensions["sni_hostname"] == "models.provider.example"
    assert "api_key" not in str(requests[0].url)


@pytest.mark.asyncio
async def test_model_preview_rejects_http_when_preview_key_is_supplied(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"data": []})

    async with application.router.lifespan_context(application):
        await application.state.model_preview_client.aclose()
        application.state.model_preview_client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://localhost"
        ) as client:
            response = await client.post(
                "/api/v1/models",
                json={
                    "preview_base_url": "http://8.8.8.8/v1",
                    "preview_api_key": "test-token",
                },
            )

    assert response.status_code == 422
    assert requests == []


@pytest.mark.asyncio
async def test_model_preview_sanitizes_upstream_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="upstream rejected credentials")

    monkeypatch.setattr(settings_api, "resolve_public_http_target", _target)
    async with application.router.lifespan_context(application):
        await application.state.model_preview_client.aclose()
        application.state.model_preview_client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://localhost"
        ) as client:
            response = await client.post(
                "/api/v1/models",
                json={
                    "preview_base_url": "https://models.provider.example/v1",
                    "preview_api_key": "test-token",
                },
            )

    assert response.status_code == 502
    assert response.json()["detail"] == "Model preview failed"


@pytest.mark.asyncio
async def test_model_preview_sanitizes_malformed_provider_payload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": "not-a-model-list"})

    monkeypatch.setattr(settings_api, "resolve_public_http_target", _target)
    async with application.router.lifespan_context(application):
        await application.state.model_preview_client.aclose()
        application.state.model_preview_client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://localhost"
        ) as client:
            response = await client.post(
                "/api/v1/models",
                json={
                    "preview_base_url": "https://models.provider.example/v1",
                    "preview_api_key": "test-token",
                },
            )

    assert response.status_code == 502
    assert response.json()["detail"] == "Model preview failed"
