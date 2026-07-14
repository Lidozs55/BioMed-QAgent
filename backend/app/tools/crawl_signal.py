"""``requires_crawl`` signal — three-tier fallback chain trigger.

When a data source has no usable API and httpx cannot fetch the page (e.g.
JS-heavy sites, anti-crawler blocks), this module generates a structured
``requires_crawl`` signal that the main agent can detect and act on by
calling the browser skill's Playwright fallback.

The signal flow follows the three-tier chain: api > httpx > crawl.

    1. skill tool tries API first (httpx calling REST endpoint)
    2. API fails → skill tool tries httpx direct page fetch
    3. httpx fails → skill tool returns ``requires_crawl`` JSON signal
    4. main agent detects signal → calls browser skill (Playwright) to crawl
"""
from __future__ import annotations

import json
from typing import Any


def requires_crawl(
    source: str,
    reason: str,
    tried_methods: list[str] | None = None,
    target_url: str | None = None,
) -> dict[str, Any]:
    """Generate a ``requires_crawl`` signal dict.

    Args:
        source: Data source name (e.g. "pubchem", "tcmsp").
        reason: Human-readable explanation of why crawl is needed.
        tried_methods: List of methods already attempted (e.g. ["api", "httpx"]).
        target_url: The URL that needs to be crawled by the browser.

    Returns:
        Dict with keys: status, source, reason, tried_methods, target_url.
        This dict should be serialized to JSON and returned by the skill tool.
    """
    return {
        "status": "requires_crawl",
        "source": source,
        "reason": reason,
        "tried_methods": tried_methods or [],
        "target_url": target_url,
    }


def requires_crawl_json(
    source: str,
    reason: str,
    tried_methods: list[str] | None = None,
    target_url: str | None = None,
) -> str:
    """Generate a ``requires_crawl`` signal as a JSON string.

    Convenience wrapper around ``requires_crawl`` for direct return from
    ``@function_tool`` functions.
    """
    return json.dumps(
        requires_crawl(source, reason, tried_methods, target_url),
        ensure_ascii=False,
    )


def check_requires_crawl(result: Any) -> bool:
    """Detect whether a tool result is a ``requires_crawl`` signal.

    Args:
        result: Either a dict (already parsed) or a JSON string (from a tool).

    Returns:
        True if the result has ``status == "requires_crawl"``.
    """
    if isinstance(result, str):
        try:
            data = json.loads(result)
        except (json.JSONDecodeError, ValueError):
            return False
    elif isinstance(result, dict):
        data = result
    else:
        return False

    return data.get("status") == "requires_crawl"


def extract_crawl_target(result: Any) -> tuple[str | None, str | None]:
    """Extract target_url and source from a requires_crawl signal.

    Args:
        result: Dict or JSON string containing a requires_crawl signal.

    Returns:
        Tuple of (target_url, source). Both may be None if not present.
    """
    if isinstance(result, str):
        try:
            data = json.loads(result)
        except (json.JSONDecodeError, ValueError):
            return None, None
    elif isinstance(result, dict):
        data = result
    else:
        return None, None

    if data.get("status") != "requires_crawl":
        return None, None

    return data.get("target_url"), data.get("source")
