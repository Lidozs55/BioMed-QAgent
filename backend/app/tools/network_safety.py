"""Safety guards for outbound HTTP requests."""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx


class UnsafeUrlError(ValueError):
    """Raised when an outbound URL may target a non-public destination."""


@dataclass(frozen=True, slots=True)
class PublicHttpTarget:
    """Connection target pinned to one validated public address."""

    connect_url: str
    host_header: str
    sni_hostname: str


def resolve_public_http_target(
    url: str,
    *,
    require_https: bool,
) -> PublicHttpTarget:
    """Resolve *url* once and return a public address-pinned HTTP target."""

    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        raise UnsafeUrlError("URL is malformed") from exc
    if parsed.scheme not in {"http", "https"}:
        raise UnsafeUrlError("only HTTP(S) URLs are allowed")
    if require_https and parsed.scheme != "https":
        raise UnsafeUrlError("credentialed requests require HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise UnsafeUrlError("URL credentials are not allowed")

    hostname = parsed.hostname
    if not hostname or hostname.lower() == "localhost":
        raise UnsafeUrlError("URL must have a public hostname")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise UnsafeUrlError("URL contains an invalid port") from exc
    try:
        addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise UnsafeUrlError(f"URL hostname could not be resolved: {hostname}") from exc
    if not addresses:
        raise UnsafeUrlError(f"URL hostname could not be resolved: {hostname}")

    resolved_addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for address in addresses:
        try:
            resolved_ip = ipaddress.ip_address(address[4][0])
        except ValueError as exc:
            raise UnsafeUrlError("URL resolved to an invalid address") from exc
        if not resolved_ip.is_global:
            raise UnsafeUrlError(f"URL resolved to a non-public address: {resolved_ip}")
        resolved_addresses.append(resolved_ip)

    resolved_ip = resolved_addresses[0]
    ip_literal = f"[{resolved_ip}]" if resolved_ip.version == 6 else str(resolved_ip)
    default_port = 443 if parsed.scheme == "https" else 80
    connect_netloc = ip_literal if port == default_port else f"{ip_literal}:{port}"
    host_header = hostname if port == default_port else f"{hostname}:{port}"
    return PublicHttpTarget(
        connect_url=parsed._replace(netloc=connect_netloc).geturl(),
        host_header=host_header,
        sni_hostname=hostname,
    )


def validate_public_http_url(url: str) -> str:
    """Return *url* when it resolves exclusively to public HTTP(S) addresses."""
    resolve_public_http_target(url, require_https=False)
    return url


def validate_credentialed_public_url(url: str) -> str:
    """Return a public HTTPS URL suitable for sending credentials."""

    resolve_public_http_target(url, require_https=True)
    return url


def validate_public_http_request(request: httpx.Request) -> None:
    """HTTPX sync request hook that validates every redirect destination."""
    validate_public_http_url(str(request.url))


async def async_validate_public_http_request(request: httpx.Request) -> None:
    """HTTPX async request hook that validates every redirect destination."""
    validate_public_http_url(str(request.url))
