"""Shared pytest fixtures for all tests."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _disable_rate_limiter(monkeypatch: pytest.MonkeyPatch) -> None:
    """Disable crawler rate limiter during tests to avoid 2s delays.

    This fixture is applied automatically to all tests. It patches the
    module-level ``_rate_limiter.wait`` function in ``app.tools.crawler``
    to be a no-op, so tests don't incur the 2s rate-limit delay.
    """
    monkeypatch.setattr("app.tools.crawler._rate_limiter.wait", lambda: None)
