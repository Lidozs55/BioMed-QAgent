"""Model preview catalog fidelity for known and discovered models."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app


@pytest.mark.asyncio
async def test_unknown_model_preview_uses_inferred_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unknown discovered models receive the generic inferred budget."""
    from app.api import settings as settings_api
    from app.tools.network_safety import PublicHttpTarget

    def _target(_: str, *, require_https: bool) -> PublicHttpTarget:
        return PublicHttpTarget(
            connect_url="https://8.8.8.8/v1",
            host_header="models.provider.example",
            sni_hostname="models.provider.example",
        )

    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    monkeypatch.setattr(settings_api, "resolve_public_http_target", _target)
    async with application.router.lifespan_context(application):
        await application.state.model_preview_client.aclose()
        application.state.model_preview_client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200, json={"data": [{"id": "unknown-custom-model"}]}
                )
            )
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://localhost",
        ) as client:
            response = await client.post(
                "/api/v1/models",
                json={
                    "preview_base_url": "https://models.provider.example/v1",
                    "preview_api_key": "test-token",
                },
            )

    assert response.status_code == 200
    models = response.json()["models"]
    unknown = next(m for m in models if m["id"] == "unknown-custom-model")
    assert unknown["context_window"] == 128_000
    assert unknown["suggested_max_tokens"] == 4_096


@pytest.mark.asyncio
async def test_known_model_preview_uses_catalog_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Known previews use catalog values and unknown previews use inferred defaults."""
    from app.api import settings as settings_api
    from app.tools.network_safety import PublicHttpTarget

    def _target(_: str, *, require_https: bool) -> PublicHttpTarget:
        return PublicHttpTarget(
            connect_url="https://8.8.8.8/v1",
            host_header="dashscope.aliyuncs.com",
            sni_hostname="dashscope.aliyuncs.com",
        )

    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    monkeypatch.setattr(settings_api, "resolve_public_http_target", _target)
    async with application.router.lifespan_context(application):
        await application.state.model_preview_client.aclose()
        application.state.model_preview_client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    json={
                        "data": [
                            {"id": "qwen-max"},
                            {"id": "unknown-custom-model"},
                        ]
                    },
                )
            )
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://localhost",
        ) as client:
            response = await client.post(
                "/api/v1/models",
                json={
                    "preview_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    "preview_api_key": "test-token",
                },
            )

    assert response.status_code == 200
    models = response.json()["models"]
    known = next(m for m in models if m["id"] == "qwen-max")
    assert known["context_window"] == 32_768
    assert known["suggested_max_tokens"] == 8_192
    unknown = next(m for m in models if m["id"] == "unknown-custom-model")
    assert unknown["context_window"] == 128_000
    assert unknown["suggested_max_tokens"] == 4_096
