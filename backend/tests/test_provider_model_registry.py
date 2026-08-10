from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app
from app.model_registry.discovery import discover_provider_models
from app.model_registry.profiles import param_specs_for
from app.model_registry.schemas import (
    ManagedModelCreate,
    ManagedModelUpdate,
    ProviderCreate,
    ProviderUpdate,
)
from app.model_registry.store import ProviderModelStore
from app.tools.network_safety import PublicHttpTarget


def make_store(tmp_path: Path) -> ProviderModelStore:
    return ProviderModelStore(tmp_path / "model_registry.db")


def test_store_provider_crud_and_duplicate_name(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    created = store.create_provider(
        ProviderCreate(
            name="我的供应商",
            base_url="https://api.example.com/v1",
            api_key="sk-secret",
            preset_id="deepseek",
        )
    )

    assert store.get_provider(created.id) is not None
    assert store.list_providers()[0].name == "我的供应商"

    with pytest.raises(ValueError):
        store.create_provider(
            ProviderCreate(name="我的供应商", base_url="https://other.example/v1")
        )

    updated = store.update_provider(
        created.id,
        ProviderUpdate(name="新代号", api_key="sk-new"),
    )
    assert updated is not None
    assert updated.name == "新代号"
    assert updated.api_key == "sk-new"

    kept = store.update_provider(created.id, ProviderUpdate(description="保持密钥"))
    assert kept is not None
    assert kept.api_key == "sk-new"

    assert store.delete_provider(created.id) is True
    assert store.delete_provider(created.id) is False
    assert store.get_provider(created.id) is None


def test_store_model_import_preserves_extra_params_and_profiles(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    provider = store.create_provider(
        ProviderCreate(
            name="deepseek",
            base_url="https://api.deepseek.com/v1",
            preset_id="deepseek",
        )
    )

    model = store.create_model(
        ManagedModelCreate(
            provider_id=provider.id,
            model_id="deepseek-chat",
            params={"max_tokens": 4096, "provider_extra": "保留"},
            extra_param="顶层多余参数",
        )
    )

    assert model.params["max_tokens"] == 4096
    assert model.params["provider_extra"] == "保留"
    assert model.params["extra_param"] == "顶层多余参数"
    assert {spec.key for spec in model.param_specs} == {
        "max_tokens",
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
    }
    assert store.get_model(model.id) is not None

    fallback_keys = {spec.key for spec in param_specs_for("unknown-provider")}
    assert fallback_keys == {
        "max_tokens",
        "temperature",
        "top_p",
        "repetition_penalty",
        "enable_search",
        "thinking_mode",
    }


def test_store_model_update_merges_and_delete_cascades(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    provider = store.create_provider(
        ProviderCreate(name="openai", base_url="https://api.openai.com/v1")
    )
    model = store.create_model(
        ManagedModelCreate(
            provider_id=provider.id,
            model_id="gpt-4o-mini",
            params={"temperature": 0.5},
        )
    )

    updated = store.update_model(
        model.id,
        ManagedModelUpdate(params={"top_p": 0.9, "unknown_key": "保留"}),
    )
    assert updated is not None
    assert updated.params["top_p"] == 0.9
    assert updated.params["unknown_key"] == "保留"
    assert updated.params["temperature"] == 0.5

    assert store.delete_provider(provider.id) is True
    assert store.get_model(model.id) is None


def test_store_activation_flags(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    provider = store.create_provider(
        ProviderCreate(name="dashscope", base_url="https://dashscope.example/v1")
    )
    store.create_model(
        ManagedModelCreate(provider_id=provider.id, model_id="qwen-plus")
    )
    second = store.create_model(
        ManagedModelCreate(provider_id=provider.id, model_id="qwen-max")
    )

    store.set_active_model(second.id)

    models = {model.model_id: model for model in store.list_models()}
    assert models["qwen-max"].active is True
    assert models["qwen-plus"].active is False


@pytest.mark.asyncio
async def test_discovery_parses_and_enriches_provider_list(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.model_registry.discovery as discovery_module

    monkeypatch.setattr(
        discovery_module,
        "resolve_public_http_target",
        lambda url, *, require_https: PublicHttpTarget(
            connect_url=url,
            host_header="api.example.com",
            sni_hostname="api.example.com",
        ),
    )

    async def fake_send(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        assert request.headers["authorization"] == "Bearer sk-key"
        return httpx.Response(
            200,
            request=request,
            json={
                "object": "list",
                "data": [
                    {"id": "qwen-plus", "owned_by": "dashscope"},
                    {"id": "brand-new-model", "extra": {"unexpected": True}},
                    "not-a-dict",
                    {"id": "qwen-plus"},
                ],
            },
        )

    models = await discover_provider_models(
        "https://api.example.com/v1",
        "sk-key",
        fake_send,
        param_specs_for("dashscope"),
    )

    assert [model.id for model in models] == ["qwen-plus", "brand-new-model"]
    qwen = models[0]
    assert qwen.capability_source == "catalog"
    assert qwen.context_window == 1_000_000
    assert qwen.suggested_max_tokens == 32000
    unknown = models[1]
    assert unknown.capability_source == "api"
    assert unknown.suggested_max_tokens == 4096


@pytest.mark.asyncio
async def test_provider_and_model_api_flow(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        created = await client.post(
            "/api/v1/model-registry/providers",
            json={
                "name": "deepseek",
                "base_url": "https://api.deepseek.com/v1",
                "api_key": "sk-very-secret-value",
                "preset_id": "deepseek",
            },
        )
        assert created.status_code == 201
        provider = created.json()
        assert provider["api_key_configured"] is True
        assert provider["api_key"] == "sk-very-...alue"
        assert provider["api_key"] != "sk-very-secret-value"

        listed = await client.get("/api/v1/model-registry/providers")
        assert listed.status_code == 200
        assert listed.json()[0]["name"] == "deepseek"

        model = await client.post(
            "/api/v1/model-registry/models",
            json={
                "provider_id": provider["id"],
                "model_id": "deepseek-chat",
                "params": {"max_tokens": 4096},
                "vendor_extra": "不要报错",
            },
        )
        assert model.status_code == 201
        model_payload = model.json()
        assert model_payload["params"]["vendor_extra"] == "不要报错"
        assert model_payload["provider_name"] == "deepseek"
        assert "presence_penalty" in {
            spec["key"] for spec in model_payload["param_specs"]
        }

        activated = await client.post(
            f"/api/v1/model-registry/models/{model_payload['id']}/activate"
        )
        assert activated.status_code == 200
        assert activated.json()["model_name"] == "deepseek-chat"
        assert activated.json()["base_url"] == "https://api.deepseek.com/v1"
        assert activated.json()["max_tokens"] == 4096
        persisted = (tmp_path / "settings" / "model.json").read_text("utf-8")
        assert "deepseek-chat" in persisted
        assert "sk-very-secret-value" in persisted

        models = await client.get("/api/v1/model-registry/models")
        assert models.status_code == 200
        assert models.json()[0]["active"] is True

        deleted = await client.delete(
            f"/api/v1/model-registry/providers/{provider['id']}"
        )
        assert deleted.status_code == 204
        empty = await client.get("/api/v1/model-registry/models")
        assert empty.json() == []


@pytest.mark.asyncio
async def test_discover_endpoint_uses_provider_credentials(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.api.provider_models as provider_router

    async def fake_discover(base_url: str, api_key: str, send: object, specs: object) -> list[dict]:
        assert api_key == "sk-discovery-secret"
        assert base_url == "https://discovery.example/v1"
        return [
            {
                "id": "discovered-1",
                "name": "discovered-1",
                "param_specs": [spec.model_dump(mode="json") for spec in specs],
            }
        ]

    monkeypatch.setattr(provider_router, "discover_provider_models", fake_discover)
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        created = await client.post(
            "/api/v1/model-registry/providers",
            json={
                "name": "discovery",
                "base_url": "https://discovery.example/v1",
                "api_key": "sk-discovery-secret",
            },
        )
        discovered = await client.post(
            f"/api/v1/model-registry/providers/{created.json()['id']}/discover",
        )

    assert discovered.status_code == 200
    assert discovered.json()[0]["id"] == "discovered-1"
