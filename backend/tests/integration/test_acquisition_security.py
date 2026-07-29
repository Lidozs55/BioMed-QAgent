from __future__ import annotations

import socket

import pytest
from app.integrations.acquisition import (
    AcquisitionFailure,
    validate_recipe_source_url,
)


def test_recipe_source_url_requires_exact_allowed_https_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", _public_dns)

    target = validate_recipe_source_url(
        "https://api.example.org/data",
        ["api.example.org"],
    )
    assert target.host == "api.example.org"
    assert target.public_target.connect_url == "https://93.184.216.34/data"
    with pytest.raises(AcquisitionFailure, match="HTTPS"):
        validate_recipe_source_url("http://api.example.org/data", ["api.example.org"])
    with pytest.raises(AcquisitionFailure, match="not allowed"):
        validate_recipe_source_url("https://api.example.org.evil.test/data", ["api.example.org"])


@pytest.mark.parametrize(
    "url",
    [
        "https://user:password@api.example.org/data",
        "https://api.example.org:8443/data",
        "https://127.0.0.1/data",
        "https://[::1]/data",
    ],
)
def test_recipe_source_url_rejects_credentials_ports_and_ip_literals(
    url: str,
) -> None:
    with pytest.raises(AcquisitionFailure):
        validate_recipe_source_url(url, ["api.example.org"])


def test_recipe_source_url_rejects_private_dns_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", 443))],
    )

    with pytest.raises(AcquisitionFailure, match="non-public"):
        validate_recipe_source_url("https://api.example.org/data", ["api.example.org"])


def test_recipe_source_url_wraps_malformed_urls_as_acquisition_failures() -> None:
    with pytest.raises(AcquisitionFailure, match="malformed"):
        validate_recipe_source_url("https://[invalid", ["api.example.org"])


def _public_dns(*args: object, **kwargs: object) -> list[tuple[object, ...]]:
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
