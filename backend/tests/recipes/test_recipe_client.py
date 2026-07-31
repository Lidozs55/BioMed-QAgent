from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable

import app.recipes.client as client_module
import httpx
import pytest
from app.integrations.acquisition import ValidatedRecipeTarget
from app.recipes.client import ControlledRecipeClient
from app.tools.browser_pool import BrowserActionResult
from app.tools.network_safety import PublicHttpTarget


class RecordingTransport(httpx.MockTransport):
    def __init__(
        self,
        handler: Callable[[httpx.Request], httpx.Response]
        | Callable[[httpx.Request], Awaitable[httpx.Response]],
    ) -> None:
        super().__init__(handler)
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True
        await super().aclose()


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
async def test_every_request_uses_and_closes_a_distinct_transport() -> None:
    transports: dict[str, list[RecordingTransport]] = {}
    observed_sni: dict[str, list[str]] = {}

    def transport_factory(sni_hostname: str) -> httpx.AsyncBaseTransport:
        observed_sni.setdefault(sni_hostname, [])

        def handler(request: httpx.Request) -> httpx.Response:
            observed_sni[sni_hostname].append(request.extensions["sni_hostname"])
            return httpx.Response(200, content=sni_hostname.encode())

        transport = RecordingTransport(handler)
        transports.setdefault(sni_hostname, []).append(transport)
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
    assert len(transports["host-a.example"]) == 2
    assert transports["host-a.example"][0] is not transports["host-a.example"][1]
    assert transports["host-a.example"][0] is not transports["host-b.example"][0]
    assert all(transport.closed for values in transports.values() for transport in values)
    assert observed_sni == {
        "host-a.example": ["host-a.example", "host-a.example"],
        "host-b.example": ["host-b.example"],
    }
    assert client.is_closed


@pytest.mark.asyncio
async def test_many_one_off_hosts_leave_no_persistent_clients() -> None:
    transports: list[RecordingTransport] = []

    def transport_factory(_sni: str) -> httpx.AsyncBaseTransport:
        transport = RecordingTransport(lambda _request: httpx.Response(200, content=b"ok"))
        transports.append(transport)
        return transport

    client = ControlledRecipeClient(transport_factory=transport_factory)
    for index in range(25):
        response = await client.api_request(
            method="GET",
            target=_target(f"host-{index}.example"),
            headers={},
            query_params={},
            timeout_seconds=5,
        )
        assert response.content == b"ok"

    assert len(transports) == 25
    assert all(transport.closed for transport in transports)
    assert not client._active_clients
    await client.aclose()


@pytest.mark.asyncio
async def test_aclose_waits_for_in_flight_request_then_rejects_new_requests() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    transports: list[RecordingTransport] = []

    async def handler(_request: httpx.Request) -> httpx.Response:
        started.set()
        await release.wait()
        return httpx.Response(200, content=b"ok")

    def transport_factory(_sni: str) -> httpx.AsyncBaseTransport:
        transport = RecordingTransport(handler)
        transports.append(transport)
        return transport

    client = ControlledRecipeClient(transport_factory=transport_factory)
    request_task = asyncio.create_task(
        client.api_request(
            method="GET",
            target=_target(),
            headers={},
            query_params={},
            timeout_seconds=5,
        )
    )
    await started.wait()
    close_task = asyncio.create_task(client.aclose())
    await asyncio.sleep(0)

    assert not close_task.done()
    release.set()
    assert (await request_task).content == b"ok"
    await close_task
    assert transports[0].closed
    with pytest.raises(RuntimeError, match="closed"):
        await client.api_request(
            method="GET",
            target=_target(),
            headers={},
            query_params={},
            timeout_seconds=5,
        )


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

    with pytest.raises(ValueError, match="fresh transport"):
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


class FakeBrowserSession:
    def __init__(
        self,
        authorize_request: Callable[..., object],
    ) -> None:
        self.authorize_request = authorize_request
        self.actions: list[str] = []
        self.closed = False

    async def action(self, **kwargs: object) -> BrowserActionResult:
        action = str(kwargs["action"])
        self.actions.append(action)
        self.authorize_request(
            str(kwargs["current_url"]),
            resource_type="main_frame",
        )
        if action == "navigate":
            self.authorize_request(
                "https://cdn.example.org/app.js",
                resource_type="script",
            )
        return BrowserActionResult(
            content=b"final-data" if action == "extract" else b"",
            status_code=200,
            media_type="text/plain" if action == "extract" else "text/html",
        )

    async def close(self) -> None:
        self.closed = True


class FakeBrowserPool:
    def __init__(self) -> None:
        self.sessions: list[FakeBrowserSession] = []

    async def open_session(
        self,
        *,
        authorize_request: Callable[..., object],
        extra_headers: dict[str, str] | None = None,
    ) -> FakeBrowserSession:
        del extra_headers
        session = FakeBrowserSession(authorize_request)
        self.sessions.append(session)
        return session


class BlockingBrowserPool(FakeBrowserPool):
    def __init__(self) -> None:
        super().__init__()
        self.open_started = asyncio.Event()
        self.release_open = asyncio.Event()

    async def open_session(
        self,
        *,
        authorize_request: Callable[..., object],
        extra_headers: dict[str, str] | None = None,
    ) -> FakeBrowserSession:
        self.open_started.set()
        await self.release_open.wait()
        return await super().open_session(
            authorize_request=authorize_request,
            extra_headers=extra_headers,
        )


@pytest.mark.asyncio
async def test_browser_adapter_reuses_isolated_session_for_all_declared_actions() -> None:
    pool = FakeBrowserPool()
    client = ControlledRecipeClient(
        transport_factory=lambda _sni: httpx.MockTransport(lambda _request: httpx.Response(200)),
        browser_pool=pool,
    )
    authorized: list[tuple[str, str]] = []

    def authorize(url: str, *, resource_type: str) -> ValidatedRecipeTarget:
        authorized.append((url, resource_type))
        return _target()

    actions = [
        ("navigate", None, "https://api.example.org/data"),
        ("click", "button.open", None),
        ("fill", "input.query", "GSE100"),
        ("select", "select.species", "human"),
        ("wait_for", "#results", None),
        ("extract", "#results", None),
    ]
    responses = []
    async with client.browser_authorization(
        authorize_request=authorize,
    ):
        for action, target, value in actions:
            responses.append(
                await client.browser_action(
                    action=action,
                    target=target,
                    value=value,
                    current_url="https://api.example.org/data",
                    timeout_seconds=5,
                )
            )

    assert len(pool.sessions) == 1
    assert pool.sessions[0].actions == [action[0] for action in actions]
    assert pool.sessions[0].closed
    assert responses[-1].content == b"final-data"
    assert authorized[0] == (
        "https://api.example.org/data",
        "main_frame",
    )
    assert (
        "https://cdn.example.org/app.js",
        "script",
    ) in authorized
    await client.aclose()


@pytest.mark.asyncio
async def test_browser_authorization_exit_closes_sequence_without_extract() -> None:
    pool = FakeBrowserPool()
    client = ControlledRecipeClient(
        browser_pool=pool,
    )

    async with client.browser_authorization(
        authorize_request=lambda *_args, **_kwargs: _target(),
    ):
        await client.browser_action(
            action="navigate",
            target=None,
            value="https://api.example.org/data",
            current_url="https://api.example.org/data",
            timeout_seconds=5,
        )
        await client.browser_action(
            action="click",
            target="button.open",
            value=None,
            current_url="https://api.example.org/data",
            timeout_seconds=5,
        )

    assert len(pool.sessions) == 1
    assert pool.sessions[0].closed
    await client.aclose()


@pytest.mark.asyncio
async def test_aclose_waits_for_in_flight_browser_session_creation_and_blocks_new_sessions() -> (
    None
):
    pool = BlockingBrowserPool()
    client = ControlledRecipeClient(browser_pool=pool)

    async def run_action() -> None:
        async with client.browser_authorization(
            authorize_request=lambda *_args, **_kwargs: _target(),
        ):
            await client.browser_action(
                action="navigate",
                target=None,
                value="https://api.example.org/data",
                current_url="https://api.example.org/data",
                timeout_seconds=5,
            )

    action_task = asyncio.create_task(run_action())
    await pool.open_started.wait()
    close_task = asyncio.create_task(client.aclose())
    await asyncio.sleep(0)

    assert not close_task.done()
    pool.release_open.set()
    await action_task
    await close_task

    assert len(pool.sessions) == 1
    assert pool.sessions[0].closed
    async with client.browser_authorization(
        authorize_request=lambda *_args, **_kwargs: _target(),
    ):
        with pytest.raises(RuntimeError, match="closed"):
            await client.browser_action(
                action="navigate",
                target=None,
                value="https://api.example.org/data",
                current_url="https://api.example.org/data",
                timeout_seconds=5,
            )
    assert len(pool.sessions) == 1
