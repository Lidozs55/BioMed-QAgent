from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app


@pytest.mark.asyncio
async def test_model_settings_mask_and_retain_saved_key(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://test"
    ) as client:
        saved = await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://example.com/v1",
                "api_key": "sk-secret-value",
                "model_name": "demo-model",
                "max_tokens": 4096,
            },
        )
        retained = await client.put(
            "/api/v1/settings",
            json={"api_key": "sk-secre...alue", "max_tokens": 2048},
        )
        loaded = await client.get("/api/v1/settings")

    assert saved.status_code == 200
    assert saved.json()["api_key"] == "sk-secre...alue"
    assert retained.status_code == 200
    assert loaded.json()["api_key"] == "sk-secre...alue"
    assert loaded.json()["api_key_configured"] is True
    persisted = (tmp_path / "settings" / "model.json").read_text("utf-8")
    assert "sk-secret-value" in persisted
    assert '"max_tokens": 2048' in persisted


@pytest.mark.asyncio
async def test_model_preview_uses_supplied_connection(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"data": [{"id": "preview-model"}]})

    async with application.router.lifespan_context(application):
        await application.state.model_preview_client.aclose()
        application.state.model_preview_client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://test"
        ) as client:
            response = await client.get(
                "/api/v1/models",
                params={
                    "preview_base_url": "https://preview.example/v1",
                    "preview_api_key": "preview-key",
                },
            )

    assert response.status_code == 200
    assert response.json()["models"][0]["id"] == "preview-model"
    assert str(requests[0].url) == "https://preview.example/v1/models"
    assert requests[0].headers["authorization"] == "Bearer preview-key"


def test_model_factory_snapshots_hot_user_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.agent_loop import model as model_module
    from app.model_settings import ModelSettingsStore, set_current_model_settings_store

    store = ModelSettingsStore(
        tmp_path / "model.json",
        defaults=Settings(dashscope_api_key="first", model_name="model-one"),
    )
    set_current_model_settings_store(store)
    created: list[dict[str, str]] = []

    class FakeClient:
        def __init__(self, *, api_key: str, base_url: str) -> None:
            created.append({"api_key": api_key, "base_url": base_url})

    monkeypatch.setattr(model_module, "AsyncOpenAI", FakeClient)
    first = model_module.get_model()
    store.update({"api_key": "second", "model_name": "model-two"})
    second = model_module.get_model()
    first._get_delegate()
    second._get_delegate()

    assert first.configuration.model_name == "model-one"
    assert second.configuration.model_name == "model-two"
    assert created[0]["api_key"] == "first"
    assert created[1]["api_key"] == "second"
