"""Phase 2: declarative HTTP tool HIL credential gate (review fix).

The gate previously lived in the deleted SkillGateway; these tests pin the
parity behavior inside DeclarativeHttpToolBuilder._approve_credential_use.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from app.databases.declarative import (
    DatabaseValidationError,
    DeclarativeHttpToolBuilder,
    HttpOperationManifest,
)

_AUTH_OP = HttpOperationManifest.model_validate(
    {
        "name": "query_protected",
        "description": "Protected query.",
        "method": "GET",
        "url": "https://example.com/api/{query}",
        "auth": {
            "source": "env",
            "reference": "DEMO_SECRET",
            "location": "header",
            "name": "X-Demo-Key",
        },
    }
)


def _child_context(decision: str) -> SimpleNamespace:
    resumed = SimpleNamespace(decision=decision)
    request_input = AsyncMock(return_value=resumed)
    return SimpleNamespace(
        context=SimpleNamespace(
            subagent_id="child-1",
            request_subagent_input=request_input,
        ),
    )


def _main_context() -> SimpleNamespace:
    return SimpleNamespace(context=SimpleNamespace(subagent_id=None))


@pytest.mark.asyncio
async def test_credential_operation_rejected_in_main_run_context() -> None:
    builder = DeclarativeHttpToolBuilder(
        secrets={"DEMO_SECRET": "s3cret"},
        http_transport=httpx.MockTransport(lambda _: httpx.Response(200, json={})),
    )
    tool = builder.build_tool(_AUTH_OP)

    with pytest.raises(DatabaseValidationError, match="HIL approval"):
        await tool.on_invoke_tool(
            _main_context(),
            json.dumps({"query": "demo"}),
        )


@pytest.mark.asyncio
async def test_credential_operation_waits_for_child_approval_and_sends_secret() -> None:
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("X-Demo-Key", "")
        return httpx.Response(200, json={"ok": True})

    builder = DeclarativeHttpToolBuilder(
        secrets={"DEMO_SECRET": "s3cret"},
        http_transport=httpx.MockTransport(handler),
    )
    tool = builder.build_tool(_AUTH_OP)

    result = await tool.on_invoke_tool(
        _child_context("approve"),
        json.dumps({"query": "demo"}),
    )

    assert result == {"ok": True}
    assert captured["auth"] == "s3cret"


@pytest.mark.asyncio
async def test_credential_operation_rejects_when_user_declines() -> None:
    builder = DeclarativeHttpToolBuilder(
        secrets={"DEMO_SECRET": "s3cret"},
        http_transport=httpx.MockTransport(lambda _: httpx.Response(200, json={})),
    )
    tool = builder.build_tool(_AUTH_OP)

    with pytest.raises(DatabaseValidationError, match="rejected by the user"):
        await tool.on_invoke_tool(
            _child_context("reject"),
            json.dumps({"query": "demo"}),
        )


@pytest.mark.asyncio
async def test_url_path_placeholders_are_percent_encoded() -> None:
    """Review parity: path substitutions are quoted, so slashes in arguments
    cannot re-target the request (retired SkillPackageLoader behavior)."""
    captured: dict[str, str] = {}
    operation = HttpOperationManifest.model_validate(
        {
            "name": "query_plain",
            "description": "Plain query.",
            "method": "GET",
            "url": "https://example.com/api/{query}/detail",
        }
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True})

    builder = DeclarativeHttpToolBuilder(
        http_transport=httpx.MockTransport(handler),
    )
    tool = builder.build_tool(operation)

    await tool.on_invoke_tool(
        _main_context(),
        json.dumps({"query": "a/b?c=d"}),
    )

    assert captured["url"] == "https://example.com/api/a%2Fb%3Fc%3Dd/detail"
