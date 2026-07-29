from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from app.domain.contracts import (
    ApiRequestStep,
    BrowserActionStep,
    RecipeAttempt,
    WorkflowRecipe,
)
from app.integrations.acquisition import AcquisitionFailure, ValidatedRecipeTarget
from app.recipes.executor import (
    RecipeExecutor,
    RecipeStepResponse,
)
from app.recipes.store import WorkflowRecipeStore
from app.subagents.staging import SubagentStagingWorkspace
from app.tools.network_safety import PublicHttpTarget, UnsafeUrlError

NOW = datetime(2026, 7, 29, tzinfo=UTC)


class ControlledClient:
    def __init__(self, responses: list[RecipeStepResponse]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.browser_contacts: list[str] = []
        self._authorize_request: Callable[..., ValidatedRecipeTarget] | None = None

    async def api_request(self, **kwargs: object) -> RecipeStepResponse:
        self.calls.append(("api", kwargs))
        return self.responses.pop(0)

    async def html_extract(self, **kwargs: object) -> RecipeStepResponse:
        self.calls.append(("html", kwargs))
        return self.responses.pop(0)

    @asynccontextmanager
    async def browser_authorization(
        self,
        *,
        authorize_request: Callable[..., ValidatedRecipeTarget],
    ) -> AsyncIterator[None]:
        assert self._authorize_request is None
        self._authorize_request = authorize_request
        try:
            yield
        finally:
            self._authorize_request = None

    async def browser_action(self, **kwargs: object) -> RecipeStepResponse:
        self.calls.append(("browser", kwargs))
        if kwargs["action"] == "navigate":
            self._contact_browser(str(kwargs["current_url"]), resource_type="main_frame")
        return self.responses.pop(0)

    def _contact_browser(
        self,
        url: str,
        *,
        resource_type: str,
    ) -> ValidatedRecipeTarget:
        if self._authorize_request is None:
            raise RuntimeError("browser transport used outside authorization scope")
        target = self._authorize_request(url, resource_type=resource_type)
        self.browser_contacts.append(url)
        return target


@pytest.mark.asyncio
async def test_executor_loads_exact_verified_version_from_trusted_store(
    tmp_path: Path,
) -> None:
    store = WorkflowRecipeStore(tmp_path / "recipes")
    verified = _store_verified(store, _api_recipe())
    client = ControlledClient([])
    executor = RecipeExecutor(client=client, store=store)

    with pytest.raises(KeyError):
        await executor.execute(
            recipe_id=verified.recipe_id,
            version=verified.version + 1,
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert client.calls == []


@pytest.mark.asyncio
async def test_http_client_receives_once_resolved_pinned_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resolutions = 0

    def resolve(url: str, *, require_https: bool) -> PublicHttpTarget:
        nonlocal resolutions
        resolutions += 1
        address = "93.184.216.34" if resolutions == 1 else "10.0.0.8"
        if address.startswith("10."):
            raise UnsafeUrlError("URL resolved to a non-public address")
        return PublicHttpTarget(
            connect_url=f"https://{address}/GSE100",
            host_header="api.example.org",
            sni_hostname="api.example.org",
        )

    monkeypatch.setattr(
        "app.integrations.acquisition.resolve_public_http_target",
        resolve,
    )
    store = WorkflowRecipeStore(tmp_path / "recipes")
    verified = _store_verified(store, _api_recipe())
    client = ControlledClient(
        [
            RecipeStepResponse(
                content=b"data",
                status_code=200,
                media_type="text/plain",
            )
        ]
    )

    await RecipeExecutor(client=client, store=store).execute(
        recipe_id=verified.recipe_id,
        version=verified.version,
        inputs={"accession": "GSE100"},
        workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
    )

    target = client.calls[0][1]["target"]
    assert isinstance(target, ValidatedRecipeTarget)
    assert target.public_target.connect_url == "https://93.184.216.34/GSE100"
    assert resolutions == 1


@pytest.mark.asyncio
async def test_api_content_uses_source_asset_mapping_without_output_name(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.integrations.acquisition.resolve_public_http_target",
        _public_target,
    )
    draft = _api_recipe().model_copy(
        update={
            "steps": [
                ApiRequestStep(
                    url_template="https://api.example.org/{accession}",
                )
            ]
        }
    )
    store = WorkflowRecipeStore(tmp_path / "recipes")
    verified = _store_verified(store, draft)
    client = ControlledClient(
        [
            RecipeStepResponse(
                content=b"mapped-output",
                status_code=200,
                media_type="text/plain",
            )
        ]
    )

    result = await RecipeExecutor(client=client, store=store).execute(
        recipe_id=verified.recipe_id,
        version=verified.version,
        inputs={"accession": "GSE100"},
        workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
    )

    assert result.source_asset.relative_path.endswith("/data.txt")


@pytest.mark.asyncio
async def test_private_redirect_is_rejected_before_second_client_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def resolve(url: str, *, require_https: bool) -> PublicHttpTarget:
        if "private.example" in url:
            raise UnsafeUrlError("URL resolved to a non-public address")
        return PublicHttpTarget(
            connect_url="https://93.184.216.34/start",
            host_header="api.example.org",
            sni_hostname="api.example.org",
        )

    monkeypatch.setattr(
        "app.integrations.acquisition.resolve_public_http_target",
        resolve,
    )
    draft = _api_recipe().model_copy(
        update={"allowed_hosts": ["api.example.org", "private.example"]}
    )
    store = WorkflowRecipeStore(tmp_path / "recipes")
    verified = _store_verified(store, draft)
    client = ControlledClient(
        [
            RecipeStepResponse(
                content=b"",
                status_code=302,
                media_type="text/plain",
                redirect_url="https://private.example/result",
            )
        ]
    )

    with pytest.raises(AcquisitionFailure, match="non-public"):
        await RecipeExecutor(client=client, store=store).execute(
            recipe_id=verified.recipe_id,
            version=verified.version,
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert [method for method, _ in client.calls] == ["api"]


@pytest.mark.asyncio
async def test_browser_authorization_blocks_private_subresource_before_transport(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def resolve(url: str, *, require_https: bool) -> PublicHttpTarget:
        if "private.example" in url:
            raise UnsafeUrlError("URL resolved to a non-public address")
        return PublicHttpTarget(
            connect_url="https://93.184.216.34/page",
            host_header="api.example.org",
            sni_hostname="api.example.org",
        )

    monkeypatch.setattr(
        "app.integrations.acquisition.resolve_public_http_target",
        resolve,
    )

    class InterceptingClient(ControlledClient):
        async def browser_action(self, **kwargs: object) -> RecipeStepResponse:
            self.calls.append(("browser", kwargs))
            self._contact_browser(
                "https://api.example.org/GSE100",
                resource_type="main_frame",
            )
            self._contact_browser(
                "https://private.example/collect",
                resource_type="image",
            )
            raise AssertionError("private browser request was contacted")

    store = WorkflowRecipeStore(tmp_path / "recipes")
    verified = _store_verified(
        store,
        _browser_recipe().model_copy(
            update={"allowed_hosts": ["api.example.org", "private.example"]}
        ),
    )
    client = InterceptingClient([])

    with pytest.raises(AcquisitionFailure, match="non-public"):
        await RecipeExecutor(client=client, store=store).execute(
            recipe_id=verified.recipe_id,
            version=verified.version,
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert client.browser_contacts == ["https://api.example.org/GSE100"]


def test_browser_response_cannot_self_report_guard_enforcement() -> None:
    with pytest.raises(TypeError, match="browser_guard_enforced"):
        RecipeStepResponse(
            content=b"claimed",
            status_code=200,
            media_type="text/plain",
            browser_guard_enforced=True,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("schema", "value"),
    [
        (
            {
                "type": "string",
                "pattern": r"^GSE\d+$",
                "minLength": 4,
                "maxLength": 12,
            },
            "bad",
        ),
        ({"type": "number", "minimum": 1, "maximum": 5}, 6),
        ({"type": "integer", "minimum": 1, "maximum": 5}, 1.5),
        ({"type": "boolean"}, 1),
        ({"type": "string", "enum": ["GSE100", "GSE200"]}, "GSE300"),
    ],
)
async def test_flat_input_schema_rejects_invalid_values_before_client(
    tmp_path: Path,
    schema: dict[str, object],
    value: object,
) -> None:
    store = WorkflowRecipeStore(tmp_path / "recipes")
    draft = _api_recipe().model_copy(
        update={
            "input_schema": {
                "type": "object",
                "properties": {"accession": schema},
                "required": ["accession"],
                "additionalProperties": False,
            }
        }
    )
    verified = _store_verified(store, draft)
    client = ControlledClient([])

    with pytest.raises(ValueError, match="input|pattern|length|minimum|maximum|type|enum"):
        await RecipeExecutor(client=client, store=store).execute(
            recipe_id=verified.recipe_id,
            version=verified.version,
            inputs={"accession": value},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert client.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "input_schema",
    [
        {
            "type": "object",
            "properties": {"nested": {"type": "object", "properties": {}}},
            "required": [],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"items": {"type": "array"}},
            "required": [],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"accession": {"type": "string", "format": "uri"}},
            "required": ["accession"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"accession": {"type": "string", "enum": [100]}},
            "required": [],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"accession": {"type": "string"}},
            "required": ["accession"],
            "additionalProperties": True,
        },
    ],
)
async def test_executor_rejects_unsupported_schema_before_client(
    tmp_path: Path,
    input_schema: dict[str, object],
) -> None:
    store = WorkflowRecipeStore(tmp_path / "recipes")
    verified = _store_verified(
        store,
        _api_recipe().model_copy(update={"input_schema": input_schema}),
    )
    client = ControlledClient([])

    with pytest.raises(ValueError, match="unsupported|additionalProperties"):
        await RecipeExecutor(client=client, store=store).execute(
            recipe_id=verified.recipe_id,
            version=verified.version,
            inputs={"accession": "GSE100"} if "accession" in input_schema["properties"] else {},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert client.calls == []


@pytest.mark.asyncio
async def test_browser_actions_continue_until_extract_with_exact_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.integrations.acquisition.resolve_public_http_target",
        _public_target,
    )
    store = WorkflowRecipeStore(tmp_path / "recipes")
    verified = _store_verified(store, _browser_recipe())
    client = ControlledClient(
        [
            RecipeStepResponse(
                content=b"",
                status_code=200,
                media_type="text/html",
            ),
            RecipeStepResponse(
                content=b"<html>intermediate</html>",
                status_code=200,
                media_type="text/html",
            ),
            RecipeStepResponse(
                content=b"final-data",
                status_code=200,
                media_type="text/plain",
            ),
        ]
    )

    result = await RecipeExecutor(client=client, store=store).execute(
        recipe_id=verified.recipe_id,
        version=verified.version,
        inputs={"accession": "GSE100"},
        workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
    )

    assert [call[1]["action"] for call in client.calls] == [
        "navigate",
        "click",
        "extract",
    ]
    assert [attempt.reason for attempt in result.attempts] == [
        "browser action navigate succeeded",
        "browser action click succeeded",
        "browser action extract succeeded",
    ]
    assert result.source_asset.size_bytes == len(b"final-data")


@pytest.mark.asyncio
async def test_browser_subresources_do_not_replace_canonical_document_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def resolve(url: str, *, require_https: bool) -> PublicHttpTarget:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        return PublicHttpTarget(
            connect_url=f"https://93.184.216.34{parsed.path or '/'}",
            host_header=host,
            sni_hostname=host,
        )

    monkeypatch.setattr(
        "app.integrations.acquisition.resolve_public_http_target",
        resolve,
    )

    class DocumentClient(ControlledClient):
        async def browser_action(self, **kwargs: object) -> RecipeStepResponse:
            self.calls.append(("browser", kwargs))
            if kwargs["action"] == "navigate":
                self._contact_browser(
                    str(kwargs["current_url"]),
                    resource_type="main_frame",
                )
                self._contact_browser(
                    "https://cdn.example.org/site.css",
                    resource_type="stylesheet",
                )
                self._contact_browser(
                    "https://cdn.example.org/logo.png",
                    resource_type="image",
                )
                self._contact_browser(
                    "https://analytics.example.org/collect",
                    resource_type="fetch",
                )
            return self.responses.pop(0)

    store = WorkflowRecipeStore(tmp_path / "recipes")
    verified = _store_verified(
        store,
        _browser_recipe().model_copy(
            update={
                "allowed_hosts": [
                    "api.example.org",
                    "cdn.example.org",
                    "analytics.example.org",
                ]
            }
        ),
    )
    client = DocumentClient(
        [
            RecipeStepResponse(content=b"", status_code=200, media_type="text/html"),
            RecipeStepResponse(content=b"", status_code=200, media_type="text/html"),
            RecipeStepResponse(
                content=b"final-data",
                status_code=200,
                media_type="text/plain",
            ),
        ]
    )

    result = await RecipeExecutor(client=client, store=store).execute(
        recipe_id=verified.recipe_id,
        version=verified.version,
        inputs={"accession": "GSE100"},
        workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
    )

    document_url = "https://api.example.org/GSE100"
    assert [call[1]["current_url"] for call in client.calls] == [
        document_url,
        document_url,
        document_url,
    ]
    assert result.download_attempt.url == document_url
    assert [attempt.url for attempt in result.attempts] == [
        document_url,
        document_url,
        document_url,
    ]


@pytest.mark.asyncio
async def test_browser_only_recipe_requires_audited_api_and_html_evidence(
    tmp_path: Path,
) -> None:
    store = WorkflowRecipeStore(tmp_path / "recipes")
    draft = _browser_recipe().model_copy(update={"attempts": []})
    verified = _store_verified(store, draft)
    client = ControlledClient([])

    with pytest.raises(ValueError, match="API and HTML.*evidence"):
        await RecipeExecutor(client=client, store=store).execute(
            recipe_id=verified.recipe_id,
            version=verified.version,
            inputs={"accession": "GSE100"},
            workspace=SubagentStagingWorkspace(tmp_path / "task", "sub_1"),
        )

    assert client.calls == []


def _api_recipe() -> WorkflowRecipe:
    return WorkflowRecipe(
        recipe_id="recipe_api",
        created_at=NOW,
        generated_by_model="qwen-plus",
        domain="gene-expression",
        capability="download",
        allowed_hosts=["api.example.org"],
        input_schema={
            "type": "object",
            "properties": {"accession": {"type": "string"}},
            "required": ["accession"],
            "additionalProperties": False,
        },
        steps=[
            ApiRequestStep(
                url_template="https://api.example.org/{accession}",
                output_name="data.txt",
            )
        ],
        source_asset_mapping={
            "source_id": "src_recipe",
            "data_level": "metadata",
            "filename": "data.txt",
        },
    )


def _browser_recipe() -> WorkflowRecipe:
    return _api_recipe().model_copy(
        update={
            "recipe_id": "recipe_browser",
            "attempts": [
                RecipeAttempt(
                    method="api",
                    url="https://api.example.org/GSE100",
                    status="failed",
                    reason="API unavailable",
                    fallback_reason="falling back to html",
                    started_at=NOW,
                    finished_at=NOW,
                ),
                RecipeAttempt(
                    method="html",
                    url="https://api.example.org/GSE100",
                    status="failed",
                    reason="HTML unavailable",
                    fallback_reason="falling back to browser",
                    started_at=NOW,
                    finished_at=NOW,
                ),
            ],
            "steps": [
                BrowserActionStep(
                    action="navigate",
                    value="https://api.example.org/{accession}",
                ),
                BrowserActionStep(action="click", target="button.download"),
                BrowserActionStep(
                    action="extract",
                    target="body",
                    output_name="data.txt",
                ),
            ],
        }
    )


def _store_verified(
    store: WorkflowRecipeStore,
    draft: WorkflowRecipe,
) -> WorkflowRecipe:
    stored = store.save_draft(draft)
    return store.mark_verified(stored.recipe_id, verification_evidence=["fixture"])


def _public_target(url: str, *, require_https: bool) -> PublicHttpTarget:
    return PublicHttpTarget(
        connect_url=url.replace("api.example.org", "93.184.216.34"),
        host_header="api.example.org",
        sni_hostname="api.example.org",
    )
