from __future__ import annotations

import asyncio
import json
from collections.abc import Callable

import app.recipes.client as client_module
import httpx
import pytest
from app.integrations.acquisition import ValidatedRecipeTarget
from app.recipes.client import ControlledRecipeClient
from app.tools.network_safety import PublicHttpTarget


def _target(host: str = "api.example.org") -> ValidatedRecipeTarget:
    return ValidatedRecipeTarget(
        url=f"https://{host}/data",
        host=host,
        public_target=PublicHttpTarget(
            connect_url="https://93.184.216.34/data",
            host_header=host,
            sni_hostname=host,
        ),
    )


def _client(
    handler: Callable[[httpx.Request], httpx.Response],
) -> ControlledRecipeClient:
    return ControlledRecipeClient(transport_factory=lambda _sni: httpx.MockTransport(handler))


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

    client = _client(handler)
    response = await client.api_request(
        method="GET",
        target=_target(),
        headers={"Host": "attacker.example", "Accept": "application/json"},
        query_params={"accession": "GSE100"},
        timeout_seconds=5,
    )
    await client.aclose()

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
async def test_same_ip_different_sni_uses_distinct_transport_pools() -> None:
    transports: dict[str, httpx.MockTransport] = {}
    observed_sni: dict[str, list[str]] = {}

    def transport_factory(sni_hostname: str) -> httpx.AsyncBaseTransport:
        observed_sni[sni_hostname] = []

        def handler(request: httpx.Request) -> httpx.Response:
            observed_sni[sni_hostname].append(request.extensions["sni_hostname"])
            return httpx.Response(200, content=sni_hostname.encode())

        transport = httpx.MockTransport(handler)
        transports[sni_hostname] = transport
        return transport

    client = ControlledRecipeClient(transport_factory=transport_factory)
    first_a, second_a, first_b = await asyncio.gather(
        client.api_request(
            method="GET",
            target=_target("host-a.example"),
            headers={},
            query_params={},
            timeout_seconds=5,
        ),
        client.api_request(
            method="GET",
            target=_target("host-a.example"),
            headers={},
            query_params={},
            timeout_seconds=5,
        ),
        client.api_request(
            method="GET",
            target=_target("host-b.example"),
            headers={},
            query_params={},
            timeout_seconds=5,
        ),
    )
    await client.aclose()

    assert first_a.content == b"host-a.example"
    assert first_b.content == b"host-b.example"
    assert second_a.content == b"host-a.example"
    assert transports["host-a.example"] is not transports["host-b.example"]
    assert observed_sni == {
        "host-a.example": ["host-a.example", "host-a.example"],
        "host-b.example": ["host-b.example"],
    }
    assert client.is_closed


@pytest.mark.asyncio
async def test_transport_factory_cannot_share_pool_between_sni_partitions() -> None:
    shared = httpx.MockTransport(lambda _request: httpx.Response(200, content=b"ok"))
    client = ControlledRecipeClient(transport_factory=lambda _sni: shared)
    await client.api_request(
        method="GET",
        target=_target("host-a.example"),
        headers={},
        query_params={},
        timeout_seconds=5,
    )

    with pytest.raises(ValueError, match="distinct transport"):
        await client.api_request(
            method="GET",
            target=_target("host-b.example"),
            headers={},
            query_params={},
            timeout_seconds=5,
        )
    await client.aclose()


@pytest.mark.asyncio
async def test_target_host_must_match_validated_sni() -> None:
    target = _target("host-a.example")
    mismatched = ValidatedRecipeTarget(
        url=target.url,
        host=target.host,
        public_target=PublicHttpTarget(
            connect_url=target.public_target.connect_url,
            host_header=target.public_target.host_header,
            sni_hostname="host-b.example",
        ),
    )
    client = _client(lambda _request: httpx.Response(200))

    with pytest.raises(ValueError, match="host and SNI must match"):
        await client.api_request(
            method="GET",
            target=mismatched,
            headers={},
            query_params={},
            timeout_seconds=5,
        )
    await client.aclose()


@pytest.mark.asyncio
async def test_html_extract_returns_deterministic_stageable_json() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text="<h1> Dataset </h1><ul><li>Alpha</li><li> Beta </li></ul>",
            headers={"content-type": "text/html; charset=utf-8"},
        )

    client = _client(handler)
    response = await client.html_extract(
        target=_target(),
        selectors={"title": "h1", "items": "li"},
        timeout_seconds=5,
    )
    await client.aclose()

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

    client = _client(handler)
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
    await client.aclose()

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

    client = _client(handler)
    response = await client.html_extract(
        target=_target(),
        selectors={"title": "h1"},
        timeout_seconds=5,
    )
    await client.aclose()

    assert response.content == b""
    assert response.error == "HTML selector produced no content: title"
    assert not response.transport_ok


@pytest.mark.asyncio
async def test_browser_interface_fails_closed() -> None:
    client = _client(lambda _request: httpx.Response(200))
    async with client.browser_authorization(authorize_request=lambda *_args, **_kwargs: _target()):
        with pytest.raises(RuntimeError, match="browser Recipe execution is unavailable"):
            await client.browser_action(
                action="navigate",
                target=None,
                value="https://api.example.org/data",
                current_url="https://api.example.org/data",
                timeout_seconds=5,
            )
    await client.aclose()
