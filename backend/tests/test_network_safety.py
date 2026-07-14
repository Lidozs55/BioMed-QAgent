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
