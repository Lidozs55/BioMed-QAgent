"""Tests for bundle layout / .env helpers."""

from __future__ import annotations

from pathlib import Path

from biomed_launcher import config


def test_parse_env_file_supports_comments_quotes_and_export() -> None:
    text = "\n".join(
        [
            "# full-line comment only",
            "",
            "PORT=6000",
            "export HOST=0.0.0.0",
            "QUOTED='single words'",
            'DQUOTED="double words"',
            "NO_EQUALS_SIGN",
            "=EMPTY_KEY",
        ]
    )
    assert config.parse_env_file(text) == {
        "PORT": "6000",
        "HOST": "0.0.0.0",
        "QUOTED": "single words",
        "DQUOTED": "double words",
    }


def test_load_env_file_reads_bom(tmp_path: Path) -> None:
    (tmp_path / config.ENV_FILE_NAME).write_bytes("﻿PORT=7001\n".encode())
    assert config.load_env_file(tmp_path) == {"PORT": "7001"}


def test_load_env_file_missing(tmp_path: Path) -> None:
    assert config.load_env_file(tmp_path) == {}


def test_resolve_port_precedence_and_defaults() -> None:
    assert config.resolve_port({}, {}) == config.DEFAULT_PORT
    # node --env-file precedence: real environment wins over the file
    assert config.resolve_port({"PORT": "7000"}, {"PORT": "6000"}) == 7000
    assert config.resolve_port({}, {"PORT": "6000"}) == 6000
    assert config.resolve_port({}, {"PORT": "abc"}) == config.DEFAULT_PORT
    assert config.resolve_port({}, {"PORT": "99999"}) == config.DEFAULT_PORT


def test_resolve_host_maps_wildcards_to_loopback() -> None:
    assert config.resolve_host({}, {}) == "127.0.0.1"
    assert config.resolve_host({"HOST": "0.0.0.0"}, {}) == "127.0.0.1"
    assert config.resolve_host({"HOST": "::"}, {}) == "127.0.0.1"
    assert config.resolve_host({}, {"HOST": "192.168.1.10"}) == "192.168.1.10"


def test_dev_bundle_root_is_repository_root() -> None:
    root = config.bundle_root()
    assert (root / "package.json").is_file()


def test_resource_path_is_none_when_not_frozen() -> None:
    if config.is_frozen():  # pragma: no cover — the exe never runs pytest
        return
    assert config.resource_path(config.ICON_RESOURCE_NAME) is None
