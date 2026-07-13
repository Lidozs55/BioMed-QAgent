"""Tests for runner event mapping helpers (Sprint 0).

Validates:
  - _extract_text_delta extracts content from ChatCompletionChunk (choices path)
  - _extract_text_delta returns None for empty/null delta
  - _extract_text_delta handles Responses API path (data.delta fallback)
  - _extract_text_delta returns None for objects with no choices
"""

from __future__ import annotations

from app.agent_loop.runner import _extract_text_delta

# ── Helper factories ────────────────────────────────────────────────


def _make_chunk(content: str | None) -> object:
    """Build a ChatCompletionChunk-like object with choices[0].delta.content."""

    class _Delta:
        pass

    delta = _Delta()
    delta.content = content  # type: ignore[attr-defined]

    class _Choice:
        pass

    choice = _Choice()
    choice.delta = delta  # type: ignore[attr-defined]

    class _Data:
        choices = [choice]

    return _Data()


def _make_chunk_no_choices() -> object:
    """Build an object with NO choices attribute."""

    class _Data:
        pass

    return _Data()


def _make_chunk_null_delta() -> object:
    """Build a chunk where choices[0].delta is None."""

    class _Choice:
        delta = None

    class _Data:
        choices = [_Choice()]

    return _Data()


def _make_responses_api_chunk(direct_delta: str) -> object:
    """Build a chunk with choices[0].delta.content=None and data.delta set."""

    class _Delta:
        content = None

    class _Choice:
        delta = _Delta()

    class _Data:
        choices = [_Choice()]
        delta = direct_delta

    return _Data()


# ── Tests ───────────────────────────────────────────────────────────


def test_extract_text_delta_choices_path() -> None:
    """Normal ChatCompletions path: choices[0].delta.content."""
    chunk = _make_chunk("hello world")
    assert _extract_text_delta(chunk) == "hello world"


def test_extract_text_delta_empty_content_returns_none() -> None:
    """Empty string content should return None (truthiness check)."""
    chunk = _make_chunk("")
    assert _extract_text_delta(chunk) is None


def test_extract_text_delta_null_content_returns_none() -> None:
    """None content should return None."""
    chunk = _make_chunk(None)
    assert _extract_text_delta(chunk) is None


def test_extract_text_delta_null_delta_returns_none() -> None:
    """When delta attribute is None, return None."""
    chunk = _make_chunk_null_delta()
    assert _extract_text_delta(chunk) is None


def test_extract_text_delta_no_choices_returns_none() -> None:
    """When choices attribute is absent, return None."""
    chunk = _make_chunk_no_choices()
    assert _extract_text_delta(chunk) is None


def test_extract_text_delta_responses_api_path() -> None:
    """Responses API fallback: when delta.content is None, check data.delta."""
    chunk = _make_responses_api_chunk("responses text")
    assert _extract_text_delta(chunk) == "responses text"


def test_extract_text_delta_unicode_content() -> None:
    """Unicode (including CJK) should be extracted correctly."""
    chunk = _make_chunk("你好世界 🌍")
    assert _extract_text_delta(chunk) == "你好世界 🌍"


def test_extract_text_delta_multi_byte_content() -> None:
    """Multi-byte content like JSON or code blocks."""
    content = '{"key": "value", "nested": {"a": 1}}'
    chunk = _make_chunk(content)
    assert _extract_text_delta(chunk) == content
