"""Shared pytest fixtures for all tests."""
from __future__ import annotations

import contextlib

import pytest


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Deselect live tests by default without blocking explicit live selection."""

    requested_args = tuple(
        str(argument).replace("\\", "/") for argument in config.invocation_params.args
    )
    explicitly_requested_live_file = any("tests/live/" in argument for argument in requested_args)
    if config.getoption("markexpr") or explicitly_requested_live_file:
        return
    live_items = [item for item in items if item.get_closest_marker("live") is not None]
    if not live_items:
        return
    config.hook.pytest_deselected(items=live_items)
    items[:] = [item for item in items if item.get_closest_marker("live") is None]


@pytest.fixture(autouse=True)
def _disable_rate_limiter(monkeypatch: pytest.MonkeyPatch) -> None:
    """Disable all rate limiters during tests to avoid 2s delays.

    This fixture is applied automatically to all tests. It patches:
    - the central ``_rate_limiter.wait`` in ``app.tools.crawler``
    - per-module ``_rate_limit`` functions in acquisition skills that
      implement their own 2s rate limiting (gdc, pdb, xena)
    """
    monkeypatch.setattr("app.tools.crawler._rate_limiter.wait", lambda: None)
    for module_path in (
        "app.skills.builtin.acquisition.gdc._rate_limit",
        "app.skills.builtin.acquisition.pdb._rate_limit",
        "app.skills.builtin.acquisition.xena._rate_limit",
    ):
        # Skill module may not be importable in all test environments.
        with contextlib.suppress(AttributeError, ModuleNotFoundError):
            monkeypatch.setattr(module_path, lambda: None)
