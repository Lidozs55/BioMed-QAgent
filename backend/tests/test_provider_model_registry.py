from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app
from app.model_registry.discovery import discover_provider_models
from app.model_registry.profiles import param_specs_for
from app.model_registry.schemas import (
    DiscoveredModel,
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
    spec_keys = {spec.key for spec in model.param_specs}
    assert {
        "max_tokens",
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
        "stop",
        "logprobs",
        "top_logprobs",
    } <= spec_keys
    assert store.get_model(model.id) is not None

    fallback_keys = {spec.key for spec in param_specs_for("unknown-provider")}
    assert {
        "max_tokens",
        "temperature",
        "top_p",
        "top_k",
        "do_sample",
        "reasoning_effort",
        "enable_thinking",
        "thinking_budget",
        "stop",
        "stream",
        "frequency_penalty",
        "presence_penalty",
        "repetition_penalty",
        "seed",
        "n",
        "logit_bias",
        "tool_choice",
        "enable_search",
        "thinking_mode",
    } <= fallback_keys


def test_provider_param_profiles_match_official_ranges() -> None:
    """Penalty ranges and vendor-specific options should match official docs."""
    for provider_id in ("openai", "deepseek", "groq"):
        specs = {spec.key: spec for spec in param_specs_for(provider_id)}
        assert specs["presence_penalty"].min == -2
        assert specs["presence_penalty"].max == 2
        assert specs["frequency_penalty"].min == -2
        assert specs["frequency_penalty"].max == 2

    zhipu = {spec.key: spec for spec in param_specs_for("zhipu")}
    assert zhipu["thinking"].type == "string"
    effort_options = {option["value"] for option in zhipu["reasoning_effort"].options}
    assert effort_options == {"max", "xhigh", "high", "medium", "low", "minimal", "none"}
    assert zhipu["reasoning_effort"].default == "max"
    assert zhipu["max_tokens"].default == 65536
    assert zhipu["max_tokens"].max == 131072
    assert zhipu["stream"].type == "boolean"

    moonshot = {spec.key: spec for spec in param_specs_for("moonshot")}
    assert moonshot["thinking"].type == "string"
    assert {"auto", "none", "required"} <= {
        option["value"] for option in moonshot["tool_choice"].options
    }

    for provider_id in ("groq", "xai", "mistral"):
        specs = {spec.key: spec for spec in param_specs_for(provider_id)}
        assert "max_tokens" in specs
        assert "temperature" in specs
        assert "top_p" in specs
    xai = {spec.key: spec for spec in param_specs_for("xai")}
    assert xai["reasoning_effort"].default == "high"
    assert {option["value"] for option in xai["reasoning_effort"].options} == {
        "low",
        "medium",
        "high",
    }
    mistral = {spec.key: spec for spec in param_specs_for("mistral")}
    assert mistral["random_seed"].type == "integer"
    assert mistral["safe_prompt"].type == "boolean"


def test_model_specific_param_specs_from_official_docs() -> None:
    """Per-model profiles should only expose parameters the model supports."""
    zhipu_45 = {spec.key: spec for spec in param_specs_for("zhipu", "glm-4.5")}
    assert "thinking" in zhipu_45
    assert "reasoning_effort" not in zhipu_45
    zhipu_52 = {spec.key: spec for spec in param_specs_for("zhipu", "glm-5.2")}
    assert "reasoning_effort" in zhipu_52
    assert zhipu_52["reasoning_effort"].default == "max"
    zhipu_flash = {spec.key: spec for spec in param_specs_for("zhipu", "glm-4v-flash")}
    assert "thinking" not in zhipu_flash
    assert "reasoning_effort" not in zhipu_flash

    k3 = {spec.key: spec for spec in param_specs_for("moonshot", "kimi/kimi-k3")}
    assert "reasoning_effort" in k3
    assert "temperature" not in k3
    assert "top_p" not in k3
    assert "thinking" not in k3
    k26 = {spec.key: spec for spec in param_specs_for("moonshot", "kimi-k2.6")}
    assert "thinking" in k26
    assert "reasoning_effort" not in k26
    assert {option["value"] for option in k26["tool_choice"].options} == {"auto", "none"}
    k27 = {spec.key: spec for spec in param_specs_for("moonshot", "kimi-k2.7-code")}
    assert k27["thinking"].default == '{"type":"enabled","keep":"all"}'
    v1 = {spec.key: spec for spec in param_specs_for("moonshot", "moonshot-v1-8k")}
    assert "temperature" in v1
    assert "thinking" not in v1

    reasoner = {spec.key: spec for spec in param_specs_for("deepseek", "deepseek-reasoner")}
    assert "temperature" not in reasoner
    assert "presence_penalty" not in reasoner
    assert "max_tokens" in reasoner

    gpt56 = {spec.key: spec for spec in param_specs_for("openai", "gpt-5.6")}
    assert {"none", "low", "medium", "high", "xhigh", "max"} <= {
        option["value"] for option in gpt56["reasoning_effort"].options
    }
    o1 = {spec.key: spec for spec in param_specs_for("openai", "o1")}
    assert "reasoning_effort" in o1
    assert "temperature" not in o1

    grok = {spec.key: spec for spec in param_specs_for("xai", "grok-4.5")}
    assert "presence_penalty" not in grok
    assert "frequency_penalty" not in grok
    assert "stop" not in grok
    assert "reasoning_effort" in grok

    # Unknown model ids fall back to the provider profile.
    generic = {spec.key: spec for spec in param_specs_for("zhipu", "brand-new-model")}
    assert "reasoning_effort" in generic


def test_store_model_specific_param_specs(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    zhipu = store.create_provider(
        ProviderCreate(
            name="zhipu",
            base_url="https://open.bigmodel.cn/api/paas/v4",
            preset_id="zhipu",
        )
    )
    model = store.create_model(
        ManagedModelCreate(provider_id=zhipu.id, model_id="glm-4.5")
    )
    keys = {spec.key for spec in model.param_specs}
    assert "thinking" in keys
    assert "reasoning_effort" not in keys

    moonshot = store.create_provider(
        ProviderCreate(
            name="moonshot",
            base_url="https://api.moonshot.cn/v1",
            preset_id="moonshot",
        )
    )
    k3 = store.create_model(
        ManagedModelCreate(provider_id=moonshot.id, model_id="kimi/kimi-k3")
    )
    k3_keys = {spec.key for spec in k3.param_specs}
    assert "reasoning_effort" in k3_keys
    assert "temperature" not in k3_keys
    assert "thinking" not in k3_keys


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

    async def fake_discover(
        base_url: str,
        api_key: str,
        send: object,
        specs: object,
    ) -> list[object]:
        assert api_key == "sk-discovery-secret"
        assert base_url == "https://discovery.example/v1"
        return [
            DiscoveredModel(
                id="discovered-1",
                name="discovered-1",
                param_specs=[spec for spec in specs],
            )
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


@pytest.mark.asyncio
async def test_provider_param_specs_endpoint(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        deepseek = await client.post(
            "/api/v1/model-registry/providers",
            json={
                "name": "deepseek",
                "base_url": "https://api.deepseek.com/v1",
                "preset_id": "deepseek",
            },
        )
        specs = await client.get(
            f"/api/v1/model-registry/providers/{deepseek.json()['id']}/param-specs"
        )
        custom = await client.post(
            "/api/v1/model-registry/providers",
            json={"name": "自定义", "base_url": "https://custom.example/v1"},
        )
        fallback = await client.get(
            f"/api/v1/model-registry/providers/{custom.json()['id']}/param-specs"
        )

    assert specs.status_code == 200
    assert "presence_penalty" in {spec["key"] for spec in specs.json()}
    assert fallback.status_code == 200
    assert {"enable_search", "thinking_mode", "repetition_penalty"} <= {
        spec["key"] for spec in fallback.json()
    }
