"""Loopback-only HTTPS CONNECT proxy with DNS-pinned public egress."""

from __future__ import annotations

import asyncio
import base64
import hmac
import ipaddress
import secrets
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from app.tools.network_safety import UnsafeUrlError

_MAX_REQUEST_HEAD_BYTES = 64 * 1024
_RELAY_CHUNK_BYTES = 64 * 1024

Resolver = Callable[[str, int], Awaitable[str]]
OpenConnection = Callable[[str, int], Awaitable[tuple[asyncio.StreamReader, Any]]]


@dataclass(slots=True)
class EgressProxyLease:
    """Per-BrowserContext proxy credentials and authorized HTTPS hosts."""

    _proxy: ControlledEgressProxy
    username: str
    password: str
    _authorized_hosts: set[str] = field(default_factory=set)
    _revoked: bool = False

    @property
    def playwright_proxy(self) -> dict[str, str]:
        """Return the proxy settings accepted by Playwright."""
        return {
            "server": f"http://{self._proxy.host}:{self._proxy.port}",
            "username": self.username,
            "password": self.password,
        }

    async def authorize_url(self, url: str) -> None:
        """Allow one HTTPS origin to be reached through this lease."""
        if self._revoked:
            raise RuntimeError("egress proxy lease is revoked")
        host, port = _https_authority(url)
        if port != 443:
            raise UnsafeUrlError("browser egress only permits HTTPS port 443")
        self._authorized_hosts.add(host)

    def permits(self, host: str) -> bool:
        return not self._revoked and _normalize_host(host) in self._authorized_hosts

    def revoke(self) -> None:
        self._revoked = True
        self._authorized_hosts.clear()


class ControlledEgressProxy:
    """Authenticate and pin every browser CONNECT to one validated public IP."""

    def __init__(
        self,
        *,
        resolver: Resolver | None = None,
        open_connection: OpenConnection = asyncio.open_connection,
    ) -> None:
        self._resolver = resolver or _resolve_public_address
        self._open_connection = open_connection
        self._server: asyncio.AbstractServer | None = None
        self._leases: dict[str, EgressProxyLease] = {}
        self._client_tasks: set[asyncio.Task[None]] = set()
        self._closed = False
        self._host = "127.0.0.1"
        self._port = 0

    @property
    def host(self) -> str:
        return self._host

    @property
    def port(self) -> int:
        if self._server is None:
            raise RuntimeError("egress proxy is not started")
        return self._port

    async def start(self) -> None:
        if self._closed:
            raise RuntimeError("egress proxy is closed")
        if self._server is not None:
            return
        self._server = await asyncio.start_server(
            self._accept_client,
            host=self._host,
            port=0,
            limit=_MAX_REQUEST_HEAD_BYTES,
        )
        sockets = self._server.sockets or ()
        if len(sockets) != 1:
            await self.close()
            raise RuntimeError("egress proxy did not bind exactly one socket")
        self._port = int(sockets[0].getsockname()[1])

    def create_lease(self) -> EgressProxyLease:
        if self._server is None or self._closed:
            raise RuntimeError("egress proxy is not available")
        username = secrets.token_urlsafe(24)
        lease = EgressProxyLease(
            _proxy=self,
            username=username,
            password=secrets.token_urlsafe(32),
        )
        self._leases[username] = lease
        return lease

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for lease in self._leases.values():
            lease.revoke()
        self._leases.clear()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        current = asyncio.current_task()
        pending = [task for task in self._client_tasks if task is not current]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    def _accept_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        task = asyncio.create_task(self._handle_client(reader, writer))
        self._client_tasks.add(task)
        task.add_done_callback(self._client_tasks.discard)

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        upstream_writer: Any | None = None
        try:
            request_head = await reader.readuntil(b"\r\n\r\n")
            if len(request_head) > _MAX_REQUEST_HEAD_BYTES:
                await _send_status(writer, 431, "Request Header Fields Too Large")
                return
            method, authority, headers = _parse_connect_request(request_head)
            if method != "CONNECT":
                await _send_status(writer, 405, "Method Not Allowed")
                return
            lease = self._authenticate(headers.get("proxy-authorization"))
            if lease is None:
                await _send_proxy_auth_required(writer)
                return
            host, port = _parse_authority(authority)
            if port != 443 or not lease.permits(host):
                await _send_status(writer, 403, "Forbidden")
                return
            pinned_ip = await self._resolver(host, port)
            _validate_public_ip(pinned_ip)
            upstream_reader, upstream_writer = await self._open_connection(
                pinned_ip,
                port,
            )
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            await _relay_bidirectionally(
                reader,
                writer,
                upstream_reader,
                upstream_writer,
            )
        except (
            asyncio.IncompleteReadError,
            asyncio.LimitOverrunError,
            UnicodeDecodeError,
            ValueError,
            UnsafeUrlError,
        ):
            await _send_status(writer, 403, "Forbidden")
        except (ConnectionError, OSError):
            await _send_status(writer, 502, "Bad Gateway")
        finally:
            if upstream_writer is not None:
                upstream_writer.close()
                await _wait_closed(upstream_writer)
            writer.close()
            await _wait_closed(writer)

    def _authenticate(self, authorization: str | None) -> EgressProxyLease | None:
        if authorization is None or not authorization.startswith("Basic "):
            return None
        try:
            decoded = base64.b64decode(
                authorization.removeprefix("Basic ").strip(),
                validate=True,
            ).decode("utf-8")
            username, password = decoded.split(":", 1)
        except (ValueError, UnicodeDecodeError):
            return None
        lease = self._leases.get(username)
        if lease is None or lease._revoked:
            return None
        if not hmac.compare_digest(lease.password, password):
            return None
        return lease


async def _resolve_public_address(host: str, port: int) -> str:
    loop = asyncio.get_running_loop()
    addresses = await loop.getaddrinfo(
        host,
        port,
        type=socket.SOCK_STREAM,
    )
    if not addresses:
        raise UnsafeUrlError(f"browser hostname could not be resolved: {host}")
    public: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for address in addresses:
        resolved_ip = ipaddress.ip_address(address[4][0])
        if not resolved_ip.is_global:
            raise UnsafeUrlError(
                f"browser hostname resolved to a non-public address: {resolved_ip}"
            )
        public.append(resolved_ip)
    selected = next((item for item in public if item.version == 4), public[0])
    return str(selected)


def _https_authority(url: str) -> tuple[str, int]:
    try:
        parsed = urlsplit(url)
        port = parsed.port or 443
    except ValueError as exc:
        raise UnsafeUrlError("browser URL is malformed") from exc
    if parsed.scheme != "https":
        raise UnsafeUrlError("browser egress only permits HTTPS URLs")
    if parsed.username is not None or parsed.password is not None:
        raise UnsafeUrlError("browser URL credentials are not allowed")
    if not parsed.hostname:
        raise UnsafeUrlError("browser URL must have a hostname")
    return _normalize_host(parsed.hostname), port


def _normalize_host(host: str) -> str:
    normalized = host.rstrip(".").lower()
    if not normalized or normalized == "localhost":
        raise UnsafeUrlError("browser URL must have a public hostname")
    return normalized.encode("idna").decode("ascii")


def _parse_connect_request(data: bytes) -> tuple[str, str, dict[str, str]]:
    lines = data.decode("iso-8859-1").split("\r\n")
    request_line = lines[0].split(" ")
    if len(request_line) != 3:
        raise ValueError("malformed proxy request")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            continue
        name, separator, value = line.partition(":")
        if not separator:
            raise ValueError("malformed proxy header")
        headers[name.strip().lower()] = value.strip()
    return request_line[0].upper(), request_line[1], headers


def _parse_authority(authority: str) -> tuple[str, int]:
    parsed = urlsplit(f"//{authority}")
    if parsed.username is not None or parsed.password is not None or not parsed.hostname:
        raise ValueError("malformed CONNECT authority")
    return _normalize_host(parsed.hostname), parsed.port or 443


def _validate_public_ip(value: str) -> None:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise UnsafeUrlError("browser resolver returned an invalid address") from exc
    if not address.is_global:
        raise UnsafeUrlError(f"browser resolver returned a non-public address: {address}")


async def _relay_bidirectionally(
    client_reader: asyncio.StreamReader,
    client_writer: Any,
    upstream_reader: asyncio.StreamReader,
    upstream_writer: Any,
) -> None:
    async def copy(reader: asyncio.StreamReader, writer: Any) -> None:
        while chunk := await reader.read(_RELAY_CHUNK_BYTES):
            writer.write(chunk)
            await writer.drain()

    upstream = asyncio.create_task(copy(client_reader, upstream_writer))
    downstream = asyncio.create_task(copy(upstream_reader, client_writer))
    done, pending = await asyncio.wait(
        {upstream, downstream},
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    await asyncio.gather(*done, *pending, return_exceptions=True)


async def _send_proxy_auth_required(writer: Any) -> None:
    writer.write(
        b"HTTP/1.1 407 Proxy Authentication Required\r\n"
        b'Proxy-Authenticate: Basic realm="BioMed-QAgent"\r\n'
        b"Content-Length: 0\r\n"
        b"Connection: close\r\n\r\n"
    )
    await writer.drain()


async def _send_status(writer: Any, status: int, reason: str) -> None:
    if writer.is_closing():
        return
    writer.write(
        (f"HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").encode(
            "ascii"
        )
    )
    await writer.drain()


async def _wait_closed(writer: Any) -> None:
    try:
        await writer.wait_closed()
    except (ConnectionError, OSError):
        return
