"""Shared pytest fixtures for all tests."""
from __future__ import annotations

import contextlib

import pytest


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
