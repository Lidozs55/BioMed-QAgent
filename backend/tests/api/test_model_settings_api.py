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
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        saved = await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://example.com/v1",
                "api_key": "sk-secret-value",
                "model_name": "qwen-max",
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
@pytest.mark.parametrize(
    "base_url",
    [
        "http://localhost:8000/v1",
        "http://127.0.0.1/v1",
        "http://169.254.169.254/v1",
        "https://user:pass@example.com/v1",
    ],
)
async def test_model_preview_rejects_non_public_base_urls(
    tmp_path: Path, base_url: str
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        response = await client.post(
            "/api/v1/models",
            json={"preview_base_url": base_url, "preview_api_key": "secret"},
        )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_only_exact_current_mask_retains_saved_key(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://example.com/v1",
                "model_name": "qwen-max",
                "max_tokens": 4096,
                "api_key": "sk-secret-value",
            },
        )
        await client.put("/api/v1/settings", json={"api_key": "literal...secret"})
        loaded = await client.get("/api/v1/settings")

    assert loaded.json()["api_key"] != "sk-secre...alue"
    assert "literal...secret" in (tmp_path / "settings" / "model.json").read_text("utf-8")


def test_model_settings_store_keeps_explicit_key_clear_after_reload(tmp_path: Path) -> None:
    from app.model_settings import ModelSettingsStore

    settings_path = tmp_path / "settings" / "model.json"
    defaults = Settings(
        dashscope_api_key="configured-default",
        dashscope_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-max",
    )
    store = ModelSettingsStore(settings_path, defaults=defaults)

    store.update({"api_key": ""})

    reloaded = ModelSettingsStore(settings_path, defaults=defaults)

    assert reloaded.snapshot().api_key == ""


def test_model_factory_snapshots_hot_user_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.agent_loop import model as model_module
    from app.model_config import RunModelSettings
    from app.model_settings import ModelSettingsStore

    store = ModelSettingsStore(
        tmp_path / "model.json",
        defaults=Settings(dashscope_api_key="first", model_name="model-one"),
    )
    store.update({"context_window": 65_536})
    created: list[dict[str, str]] = []

    class FakeClient:
        def __init__(self, *, api_key: str, base_url: str) -> None:
            created.append({"api_key": api_key, "base_url": base_url})

    monkeypatch.setattr(model_module, "AsyncOpenAI", FakeClient)
    first = model_module.get_model(
        model_module.to_run_model_settings(store.snapshot())
    )
    store.update(
        {
            "api_key": "second",
            "model_name": "model-two",
            "context_window": 131_072,
        }
    )
    second = model_module.get_model(
        model_module.to_run_model_settings(store.snapshot())
    )
    first._get_delegate()
    second._get_delegate()

    assert isinstance(first._model_settings, RunModelSettings)
    assert isinstance(second._model_settings, RunModelSettings)
    assert first._model_settings.model_name == "model-one"
    assert second._model_settings.model_name == "model-two"
    assert created[0]["api_key"] == "first"
    assert created[1]["api_key"] == "second"


def test_model_factory_exposes_request_defaults(tmp_path: Path) -> None:
    from app.agent_loop import model as model_module
    from app.agent_loop.model import get_model
    from app.model_settings import ModelSettingsStore

    store = ModelSettingsStore(
        tmp_path / "model.json",
        defaults=Settings(
            dashscope_api_key="key",
            dashscope_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            model_name="qwen-plus",
        ),
    )
    store.update(
        {
            "max_tokens": 1234,
            "temperature": 0.2,
            "top_p": 0.8,
            "repetition_penalty": 1.1,
            "enable_search": True,
            "thinking_mode": True,
        }
    )
    defaults = get_model(
        model_module.to_run_model_settings(store.snapshot())
    ).model_settings

    assert defaults.max_tokens == 1234
    assert defaults.temperature == 0.2
    assert defaults.top_p == 0.8
    assert defaults.extra_body == {
        "repetition_penalty": 1.1,
        "enable_search": True,
        "enable_thinking": True,
    }


def test_model_factory_omits_dashscope_body_for_openai_endpoint(tmp_path: Path) -> None:
    from app.agent_loop import model as model_module
    from app.agent_loop.model import get_model
    from app.model_settings import ModelSettingsStore

    store = ModelSettingsStore(
        tmp_path / "model.json",
        defaults=Settings(
            dashscope_api_key="key",
            dashscope_base_url="https://api.openai.com/v1",
            model_name="gpt-4o",
        ),
    )
    assert (
        get_model(model_module.to_run_model_settings(store.snapshot())).model_settings.extra_body
        is None
    )
