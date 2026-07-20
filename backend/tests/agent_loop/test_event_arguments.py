"""Tests for ToolStartedPayload.arguments injection and output truncation.

Covers spec §2.6:
1. arguments field successful injection (mock raw_item.arguments as valid JSON)
2. depth truncation: nested dict exceeding depth=3 replaced with [dict:N]
3. string truncation: strings exceeding 200 chars truncated
4. list truncation: lists exceeding 20 items truncated
5. parse failure returns None (malformed JSON)
6. backward compat: legacy events.jsonl (no arguments field) loads fine
7. output truncated to 4KB
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from app.agent_loop.runner import (
    TOOL_OUTPUT_MAX_BYTES,
    _extract_tool_arguments,
    _truncate_for_event,
    _truncate_tool_output,
)
from app.domain.contracts import ToolCompletedPayload, ToolStartedPayload


class TestTruncateForEvent:
    """Test _truncate_for_event helper (spec §2.3)."""

    def test_string_under_limit_returned_as_is(self) -> None:
        assert _truncate_for_event("short") == "short"

    def test_string_over_limit_truncated_with_marker(self) -> None:
        long_str = "x" * 300
        result = _truncate_for_event(long_str)
        assert isinstance(result, str)
        assert result.endswith("...[truncated]")
        assert len(result) == 200 + len("...[truncated]")

    def test_primitive_values_returned_as_is(self) -> None:
        assert _truncate_for_event(42) == 42
        assert _truncate_for_event(3.14) == 3.14
        assert _truncate_for_event(True) is True
        assert _truncate_for_event(None) is None

    def test_list_under_limit_preserved(self) -> None:
        result = _truncate_for_event([1, 2, 3])
        assert result == [1, 2, 3]

    def test_list_over_limit_truncated_to_20(self) -> None:
        big_list = list(range(25))
        result = _truncate_for_event(big_list)
        assert isinstance(result, list)
        assert len(result) == 20
        assert result[0] == 0
        assert result[19] == 19

    def test_dict_depth_truncation_replaces_with_count(self) -> None:
        # depth=3: root dict (d=3) -> child dict (d=2) -> grandchild dict (d=1) -> great-grandchild (d=0 -> [dict:N])
        deep = {"a": {"b": {"c": {"d": "value"}}}}
        result = _truncate_for_event(deep, depth=3)
        assert isinstance(result, dict)
        assert isinstance(result["a"], dict)
        assert isinstance(result["a"]["b"], dict)
        # At depth=0 the innermost dict becomes a count placeholder
        assert result["a"]["b"]["c"] == "[dict:1]"

    def test_dict_under_depth_preserved(self) -> None:
        shallow = {"a": {"b": "value"}}
        result = _truncate_for_event(shallow, depth=3)
        assert result == {"a": {"b": "value"}}

    def test_list_depth_truncation_replaces_with_count(self) -> None:
        deep_list = [[[[1]]]]
        result = _truncate_for_event(deep_list, depth=1)
        # depth=1: root list (d=1) -> child list (d=0 -> [list:N])
        assert result == ["[list:1]"]


class TestExtractToolArguments:
    """Test _extract_tool_arguments helper (spec §2.2)."""

    def test_valid_json_arguments_returned_truncated(self) -> None:
        raw_item = SimpleNamespace(arguments='{"query": "lung cancer", "limit": 10}')
        result = _extract_tool_arguments(raw_item)
        assert result == {"query": "lung cancer", "limit": 10}

    def test_missing_arguments_returns_none(self) -> None:
        raw_item = SimpleNamespace()
        assert _extract_tool_arguments(raw_item) is None

    def test_empty_arguments_string_returns_none(self) -> None:
        raw_item = SimpleNamespace(arguments="")
        assert _extract_tool_arguments(raw_item) is None

    def test_malformed_json_returns_none(self) -> None:
        raw_item = SimpleNamespace(arguments="{not valid json")
        assert _extract_tool_arguments(raw_item) is None

    def test_non_dict_json_returns_none(self) -> None:
        raw_item = SimpleNamespace(arguments='[1, 2, 3]')
        assert _extract_tool_arguments(raw_item) is None

    def test_dict_arguments_passthrough_truncated(self) -> None:
        # Some SDK variants may return dict directly instead of JSON string
        raw_item = SimpleNamespace(arguments={"query": "test"})
        result = _extract_tool_arguments(raw_item)
        assert result == {"query": "test"}

    def test_long_string_argument_truncated(self) -> None:
        long_value = "x" * 500
        raw_item = SimpleNamespace(arguments=f'{{"query": "{long_value}"}}')
        result = _extract_tool_arguments(raw_item)
        assert isinstance(result, dict)
        assert isinstance(result["query"], str)
        assert result["query"].endswith("...[truncated]")
        assert len(result["query"]) == 200 + len("...[truncated]")

    def test_nested_dict_depth_truncated(self) -> None:
        # 4 levels of nesting; depth=3 truncates the deepest
        nested = '{"a": {"b": {"c": {"d": {"e": "deep"}}}}}'
        raw_item = SimpleNamespace(arguments=nested)
        result = _extract_tool_arguments(raw_item)
        assert isinstance(result, dict)
        assert result["a"]["b"]["c"] == "[dict:1]"

    def test_large_list_argument_truncated(self) -> None:
        big_list = list(range(25))
        raw_item = SimpleNamespace(arguments=json.dumps({"ids": big_list}))
        result = _extract_tool_arguments(raw_item)
        assert isinstance(result, dict)
        assert isinstance(result["ids"], list)
        assert len(result["ids"]) == 20


class TestTruncateToolOutput:
    """Test _truncate_tool_output helper (spec §2.4)."""

    def test_short_output_returned_as_is(self) -> None:
        assert _truncate_tool_output("short output") == "short output"

    def test_long_output_truncated_to_4kb(self) -> None:
        long_output = "x" * (TOOL_OUTPUT_MAX_BYTES + 1000)
        result = _truncate_tool_output(long_output)
        assert result.endswith("...[truncated]")
        assert len(result) == TOOL_OUTPUT_MAX_BYTES + len("...[truncated]")

    def test_non_string_output_stringified(self) -> None:
        result = _truncate_tool_output({"key": "value"})
        assert isinstance(result, str)
        assert "key" in result

    def test_exactly_at_limit_not_truncated(self) -> None:
        exact = "x" * TOOL_OUTPUT_MAX_BYTES
        result = _truncate_tool_output(exact)
        assert result == exact
        assert "...[truncated]" not in result


class TestToolStartedPayloadSchema:
    """Test ToolStartedPayload schema (spec §2.1, §2.5 backward compat)."""

    def test_arguments_field_optional_defaults_none(self) -> None:
        payload = ToolStartedPayload(
            tool_call_id="call_1",
            tool_name="search_pubmed",
        )
        assert payload.arguments is None

    def test_arguments_field_accepts_dict(self) -> None:
        payload = ToolStartedPayload(
            tool_call_id="call_1",
            tool_name="search_pubmed",
            arguments={"query": "lung cancer", "limit": 10},
        )
        assert payload.arguments == {"query": "lung cancer", "limit": 10}

    def test_arguments_field_accepts_none_explicitly(self) -> None:
        payload = ToolStartedPayload(
            tool_call_id="call_1",
            tool_name="search_pubmed",
            arguments=None,
        )
        assert payload.arguments is None

    def test_legacy_payload_without_arguments_field_loads(self) -> None:
        """Backward compat: old events.jsonl has no arguments field."""
        legacy_json = {
            "type": "tool_started",
            "tool_call_id": "call_1",
            "tool_name": "search_pubmed",
        }
        payload = ToolStartedPayload.model_validate(legacy_json)
        assert payload.tool_call_id == "call_1"
        assert payload.tool_name == "search_pubmed"
        assert payload.arguments is None

    def test_serialization_roundtrip_preserves_arguments(self) -> None:
        payload = ToolStartedPayload(
            tool_call_id="call_1",
            tool_name="download_supplementary",
            arguments={"pmid": "12345", "suppl_kind": "pdf"},
        )
        serialized = payload.model_dump()
        restored = ToolStartedPayload.model_validate(serialized)
        assert restored.arguments == {"pmid": "12345", "suppl_kind": "pdf"}


class TestToolCompletedPayloadOutputTruncation:
    """Test ToolCompletedPayload accepts truncated output (spec §2.4)."""

    def test_short_output_accepted(self) -> None:
        payload = ToolCompletedPayload(
            tool_call_id="call_1",
            tool_name="search_pubmed",
            output="result",
        )
        assert payload.output == "result"

    def test_truncated_output_accepted(self) -> None:
        truncated = "x" * 100 + "...[truncated]"
        payload = ToolCompletedPayload(
            tool_call_id="call_1",
            tool_name="search_pubmed",
            output=truncated,
        )
        assert payload.output == truncated
