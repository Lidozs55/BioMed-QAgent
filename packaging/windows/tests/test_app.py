"""Tests for the GUI/fallback decision logic (fake webview module)."""

from __future__ import annotations

import sys
import types

import pytest
from biomed_launcher import app, config


class _FakeEvent:
    def __init__(self) -> None:
        self.handlers: list[object] = []

    def __iadd__(self, handler: object) -> _FakeEvent:
        self.handlers.append(handler)
        return self


class _FakeWindow:
    def __init__(self) -> None:
        self.events = types.SimpleNamespace(loaded=_FakeEvent(), shown=_FakeEvent())
        self.native = None


def install_fake_webview(monkeypatch: pytest.MonkeyPatch, *, fail: bool) -> dict[str, object]:
    created: dict[str, object] = {}

    def create_window(title: str, url: str, **kwargs: object) -> _FakeWindow:
        created.update({"title": title, "url": url, **kwargs})
        return _FakeWindow()

    def start(**_kwargs: object) -> None:
        if fail:
            raise RuntimeError("WebView2 runtime is not installed")

    module = types.SimpleNamespace(
        settings={},
        create_window=create_window,
        start=start,
    )
    monkeypatch.setitem(sys.modules, "webview", module)
    return created


def test_open_user_interface_prefers_webview(monkeypatch: pytest.MonkeyPatch) -> None:
    created = install_fake_webview(monkeypatch, fail=False)
    dialogs: list[str] = []

    mode = app.open_user_interface("http://127.0.0.1:5173", info_dialog=dialogs.append)

    assert mode == "webview"
    assert created["url"] == "http://127.0.0.1:5173"
    assert created["title"] == config.WINDOW_TITLE
    assert created["min_size"] == app.MIN_WINDOW_SIZE
    assert dialogs == []


def test_open_user_interface_falls_back_to_browser_on_webview_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_fake_webview(monkeypatch, fail=True)
    opened: list[str] = []
    monkeypatch.setattr(app.webbrowser, "open", lambda url: opened.append(url) or True)
    dialogs: list[str] = []

    mode = app.open_user_interface("http://127.0.0.1:6000", info_dialog=dialogs.append)

    assert mode == "browser"
    assert opened == ["http://127.0.0.1:6000"]
    assert len(dialogs) == 1


def test_open_user_interface_force_browser_skips_webview(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No fake webview installed: if the launcher tried to import it anyway the
    # fallback except-branch would swallow the difference — assert via mode
    # plus the fact that the real (possibly importable) webview never opens a
    # window because force_browser short-circuits before the import.
    opened: list[str] = []
    monkeypatch.setattr(app.webbrowser, "open", lambda url: opened.append(url) or True)

    mode = app.open_user_interface(
        "http://127.0.0.1:5173", force_browser=True, info_dialog=lambda _text: None
    )

    assert mode == "browser"
    assert opened == ["http://127.0.0.1:5173"]


def test_force_browser_env_is_respected(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(app.webbrowser, "open", lambda url: opened.append(url) or True)
    monkeypatch.setenv(config.FORCE_BROWSER_ENV, "1")

    mode = app.open_user_interface("http://127.0.0.1:5173", info_dialog=lambda _text: None)

    assert mode == "browser"
    assert opened == ["http://127.0.0.1:5173"]


def test_truthy_values() -> None:
    assert app.truthy(None) is False
    assert app.truthy("") is False
    assert app.truthy("0") is False
    assert app.truthy("false") is False
    assert app.truthy("1") is True
    assert app.truthy("yes") is True
