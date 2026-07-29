from __future__ import annotations

import json

import app.recipes.client as client_module
import httpx
import pytest
from app.integrations.acquisition import ValidatedRecipeTarget
from app.recipes.client import ControlledRecipeClient
from app.tools.network_safety import PublicHttpTarget


def _target() -> ValidatedRecipeTarget:
    return ValidatedRecipeTarget(
        url="https://api.example.org/data",
        host="api.example.org",
        public_target=PublicHttpTarget(
            connect_url="https://93.184.216.34/data",
            host_header="api.example.org",
            sni_hostname="api.example.org",
        ),
    )


@pytest.mark.asyncio
async def test_api_request_uses_pinned_target_and_returns_redirect_without_following() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            302,
            content=b"must-not-be-treated-as-output",
            headers={"location": "/redirected"},
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        follow_redirects=True,
    ) as http:
        response = await ControlledRecipeClient(http).api_request(
            method="GET",
            target=_target(),
            headers={"Host": "attacker.example", "Accept": "application/json"},
            query_params={"accession": "GSE100"},
            timeout_seconds=5,
        )

    assert len(requests) == 1
    assert str(requests[0].url) == ("https://93.184.216.34/data?accession=GSE100")
    assert requests[0].headers["host"] == "api.example.org"
    assert requests[0].headers["accept"] == "application/json"
    assert requests[0].extensions["sni_hostname"] == "api.example.org"
    assert response.status_code == 302
    assert response.redirect_url == "/redirected"
    assert response.content == b""
    assert not response.transport_ok


@pytest.mark.asyncio
async def test_html_extract_returns_deterministic_stageable_json() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text="<h1> Dataset </h1><ul><li>Alpha</li><li> Beta </li></ul>",
            headers={"content-type": "text/html; charset=utf-8"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        response = await ControlledRecipeClient(http).html_extract(
            target=_target(),
            selectors={"title": "h1", "items": "li"},
            timeout_seconds=5,
        )

    assert response.transport_ok
    assert response.media_type == "application/json"
    assert response.content == (b'{"items":["Alpha","Beta"],"title":["Dataset"]}')
    assert json.loads(response.content) == {
        "items": ["Alpha", "Beta"],
        "title": ["Dataset"],
    }


@pytest.mark.asyncio
async def test_api_request_rejects_stream_larger_than_fixed_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(client_module, "MAX_RECIPE_RESPONSE_BYTES", 8)
    bodies = iter([b"12345678", b"123456789"])

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=next(bodies))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = ControlledRecipeClient(http)
        exact = await client.api_request(
            method="GET",
            target=_target(),
            headers={},
            query_params={},
            timeout_seconds=5,
        )
        oversized = await client.api_request(
            method="GET",
            target=_target(),
            headers={},
            query_params={},
            timeout_seconds=5,
        )

    assert exact.content == b"12345678"
    assert exact.transport_ok
    assert oversized.content == b""
    assert oversized.error == "Recipe response exceeded 8 byte limit"
    assert not oversized.transport_ok


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "html",
    [
        "<p>different element</p>",
        "<h1>   </h1>",
    ],
)
async def test_html_extract_fails_when_a_selector_has_no_content(html: str) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        response = await ControlledRecipeClient(http).html_extract(
            target=_target(),
            selectors={"title": "h1"},
            timeout_seconds=5,
        )

    assert response.content == b""
    assert response.error == "HTML selector produced no content: title"
    assert not response.transport_ok


@pytest.mark.asyncio
async def test_browser_interface_fails_closed() -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200))
    ) as http:
        client = ControlledRecipeClient(http)
        async with client.browser_authorization(
            authorize_request=lambda *_args, **_kwargs: _target()
        ):
            with pytest.raises(RuntimeError, match="browser Recipe execution is unavailable"):
                await client.browser_action(
                    action="navigate",
                    target=None,
                    value="https://api.example.org/data",
                    current_url="https://api.example.org/data",
                    timeout_seconds=5,
                )
