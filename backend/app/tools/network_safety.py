"""Safety guards for outbound HTTP requests."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

import httpx


class UnsafeUrlError(ValueError):
    """Raised when an outbound URL may target a non-public destination."""


def validate_public_http_url(url: str) -> str:
    """Return *url* when it resolves exclusively to public HTTP(S) addresses."""
    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        raise UnsafeUrlError("URL is malformed") from exc
    if parsed.scheme not in {"http", "https"}:
        raise UnsafeUrlError("only HTTP(S) URLs are allowed")
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
    for address in addresses:
        try:
            resolved_ip = ipaddress.ip_address(address[4][0])
        except ValueError as exc:
            raise UnsafeUrlError("URL resolved to an invalid address") from exc
        if not resolved_ip.is_global:
            raise UnsafeUrlError(f"URL resolved to a non-public address: {resolved_ip}")
    return url


def validate_public_http_request(request: httpx.Request) -> None:
    """HTTPX sync request hook that validates every redirect destination."""
    validate_public_http_url(str(request.url))


async def async_validate_public_http_request(request: httpx.Request) -> None:
    """HTTPX async request hook that validates every redirect destination."""
    validate_public_http_url(str(request.url))
