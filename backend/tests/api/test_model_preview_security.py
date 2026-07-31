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
async def test_model_preview_client_ignores_environment_proxies(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application):
        assert application.state.model_preview_client.trust_env is False


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


@pytest.mark.asyncio
async def test_model_preview_does_not_follow_redirects_or_leak_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            302, headers={"location": "https://redirect.example/v1/models"}, request=request
        )

    monkeypatch.setattr(settings_api, "resolve_public_http_target", _target)
    async with application.router.lifespan_context(application):
        await application.state.model_preview_client.aclose()
        application.state.model_preview_client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), follow_redirects=False
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
    assert len(requests) == 1
    assert requests[0].headers["authorization"] == "Bearer test-token"
    assert "test-token" not in response.text
    assert "redirect.example" not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "content"),
    [
        ("provider_status", b'{"error":"upstream secret response"}'),
        ("invalid_json", b"not valid json"),
        ("timeout", b""),
        ("connection", b""),
    ],
)
async def test_model_preview_sanitizes_transport_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
    content: bytes,
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))

    def handler(request: httpx.Request) -> httpx.Response:
        if failure == "timeout":
            raise httpx.ReadTimeout("upstream secret", request=request)
        if failure == "connection":
            raise httpx.ConnectError("upstream secret", request=request)
        status_code = 500 if failure == "provider_status" else 200
        return httpx.Response(status_code, content=content, request=request)

    monkeypatch.setattr(settings_api, "resolve_public_http_target", _target)
    async with application.router.lifespan_context(application):
        await application.state.model_preview_client.aclose()
        application.state.model_preview_client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), follow_redirects=False
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
    assert "test-token" not in response.text
    assert "upstream secret" not in response.text
