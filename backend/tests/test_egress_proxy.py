from __future__ import annotations

import asyncio
import base64

import pytest
from app.tools.egress_proxy import ControlledEgressProxy
from app.tools.network_safety import UnsafeUrlError


class FakeUpstreamWriter:
    def __init__(self) -> None:
        self.closed = False

    def write(self, _data: bytes) -> None:
        return None

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None


def _authorization(username: str, password: str) -> str:
    encoded = base64.b64encode(f"{username}:{password}".encode()).decode()
    return f"Basic {encoded}"


async def _connect(
    proxy: ControlledEgressProxy,
    *,
    host: str,
    authorization: str,
) -> bytes:
    reader, writer = await asyncio.open_connection(proxy.host, proxy.port)
    writer.write(
        (
            f"CONNECT {host}:443 HTTP/1.1\r\n"
            f"Host: {host}:443\r\n"
            f"Proxy-Authorization: {authorization}\r\n\r\n"
        ).encode()
    )
    await writer.drain()
    response = await reader.read(4096)
    writer.close()
    await writer.wait_closed()
    return response


@pytest.mark.asyncio
async def test_connect_resolves_once_and_opens_only_the_pinned_public_ip() -> None:
    resolutions = iter(["93.184.216.34", "127.0.0.1"])
    resolved_hosts: list[tuple[str, int]] = []
    opened: list[tuple[str, int]] = []
    upstream_writers: list[FakeUpstreamWriter] = []

    async def resolve(host: str, port: int) -> str:
        resolved_hosts.append((host, port))
        return next(resolutions)

    async def open_connection(
        host: str,
        port: int,
    ) -> tuple[asyncio.StreamReader, FakeUpstreamWriter]:
        opened.append((host, port))
        reader = asyncio.StreamReader()
        reader.feed_eof()
        writer = FakeUpstreamWriter()
        upstream_writers.append(writer)
        return reader, writer

    proxy = ControlledEgressProxy(
        resolver=resolve,
        open_connection=open_connection,
    )
    await proxy.start()
    lease = proxy.create_lease()
    await lease.authorize_url("https://example.org/data")

    response = await _connect(
        proxy,
        host="example.org",
        authorization=_authorization(lease.username, lease.password),
    )
    await proxy.close()

    assert response.startswith(b"HTTP/1.1 200")
    assert resolved_hosts == [("example.org", 443)]
    assert opened == [("93.184.216.34", 443)]
    assert upstream_writers[0].closed


@pytest.mark.asyncio
async def test_connect_rejects_private_resolution_before_opening_transport() -> None:
    opened: list[tuple[str, int]] = []

    async def resolve(_host: str, _port: int) -> str:
        raise UnsafeUrlError("CONNECT resolved to a non-public address")

    async def open_connection(
        host: str,
        port: int,
    ) -> tuple[asyncio.StreamReader, FakeUpstreamWriter]:
        opened.append((host, port))
        raise AssertionError("private target must not be opened")

    proxy = ControlledEgressProxy(
        resolver=resolve,
        open_connection=open_connection,
    )
    await proxy.start()
    lease = proxy.create_lease()
    await lease.authorize_url("https://private.example/data")

    response = await _connect(
        proxy,
        host="private.example",
        authorization=_authorization(lease.username, lease.password),
    )
    await proxy.close()

    assert response.startswith(b"HTTP/1.1 403")
    assert opened == []


@pytest.mark.asyncio
async def test_connect_requires_authenticated_pre_authorized_https_host() -> None:
    resolved: list[str] = []

    async def resolve(host: str, _port: int) -> str:
        resolved.append(host)
        return "93.184.216.34"

    async def unused_open(
        _host: str,
        _port: int,
    ) -> tuple[asyncio.StreamReader, FakeUpstreamWriter]:
        raise AssertionError("unauthorized host must not be opened")

    proxy = ControlledEgressProxy(
        resolver=resolve,
        open_connection=unused_open,
    )
    await proxy.start()
    lease = proxy.create_lease()
    await lease.authorize_url("https://allowed.example/data")

    response = await _connect(
        proxy,
        host="other.example",
        authorization=_authorization(lease.username, lease.password),
    )
    await proxy.close()

    assert response.startswith(b"HTTP/1.1 403")
    assert resolved == []
