"""Tests for outbound public-network URL validation."""

from __future__ import annotations

import asyncio
import socket
from unittest.mock import patch

import httpx
import pytest
from app.tools.network_safety import (
    UnsafeUrlError,
    async_validate_public_http_request,
    resolve_public_http_target,
    validate_public_http_request,
    validate_public_http_url,
)


def _dns_result(address: str) -> list[tuple[object, ...]]:
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    return [(family, socket.SOCK_STREAM, 6, "", (address, 443))]


def test_public_https_url_is_accepted() -> None:
    with patch("app.tools.network_safety.socket.getaddrinfo", return_value=_dns_result("93.184.216.34")):
        assert validate_public_http_url("https://example.org/data") == "https://example.org/data"


@pytest.mark.parametrize(
    ("address", "url", "connect_url", "host_header"),
    [
        (
            "93.184.216.34",
            "https://example.org/data",
            "https://93.184.216.34/data",
            "example.org",
        ),
        (
            "2606:2800:220:1:248:1893:25c8:1946",
            "https://example.org:8443/data",
            "https://[2606:2800:220:1:248:1893:25c8:1946]:8443/data",
            "example.org:8443",
        ),
    ],
)
def test_public_target_pins_validated_address_and_preserves_identity(
    address: str,
    url: str,
    connect_url: str,
    host_header: str,
) -> None:
    with patch(
        "app.tools.network_safety.socket.getaddrinfo",
        return_value=_dns_result(address),
    ):
        target = resolve_public_http_target(url, require_https=True)

    assert target.connect_url == connect_url
    assert target.host_header == host_header
    assert target.sni_hostname == "example.org"


def test_credentialed_target_rejects_plain_http() -> None:
    with pytest.raises(UnsafeUrlError, match="HTTPS"):
        resolve_public_http_target("http://8.8.8.8/data", require_https=True)


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.org/data",
        "http://user:pass@example.org",
        "http://localhost/data",
        "http://127.0.0.1/data",
        "http://169.254.169.254/latest/meta",
    ],
)
def test_unsafe_url_forms_are_rejected(url: str) -> None:
    with pytest.raises(UnsafeUrlError):
        validate_public_http_url(url)


def test_hostname_resolving_to_private_address_is_rejected() -> None:
    with (
        patch("app.tools.network_safety.socket.getaddrinfo", return_value=_dns_result("10.0.0.8")),
        pytest.raises(UnsafeUrlError),
    ):
        validate_public_http_url("https://private.example/data")


def test_sync_httpx_request_hook_calls_validator() -> None:
    request = httpx.Request("GET", "https://example.org/data")
    with patch("app.tools.network_safety.validate_public_http_url") as validator:
        validate_public_http_request(request)
    validator.assert_called_once_with(str(request.url))


def test_async_httpx_request_hook_calls_validator() -> None:
    request = httpx.Request("GET", "https://example.org/data")
    with patch("app.tools.network_safety.validate_public_http_url") as validator:
        asyncio.run(async_validate_public_http_request(request))
    validator.assert_called_once_with(str(request.url))
