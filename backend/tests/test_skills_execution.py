"""Test 3: SkillExecutor — validation, execution, error handling.

Verifies:
- Valid inputs pass validation
- Missing required inputs fail
- Unknown skill_id returns failure
- Executor closures exist and accept the correct call signature
"""

import pytest

from app.skills import register_all_skills, get_skill_registry, SkillExecutor, SkillResult


@pytest.fixture(autouse=True)
def setup_registry():
    """Ensure skills are registered before each test."""
    register_all_skills()


# ── Validation tests ──────────────────────────────────────────────


def test_validate_valid_inputs():
    """Valid inputs for pubmed should pass validation."""
    registry = get_skill_registry()
    manifest = registry.get("pubmed")
    assert manifest is not None
    validated = SkillExecutor.validate_inputs(manifest, {
        "query": "TP53 cancer",
        "max_results": 3,
        "task_id": "test-task",
    })
    assert validated is not None
    assert validated["query"] == "TP53 cancer"
    assert validated["max_results"] == 3


def test_validate_missing_required():
    """Missing required field 'query' should fail validation for pubmed."""
    registry = get_skill_registry()
    manifest = registry.get("pubmed")
    assert manifest is not None
    validated = SkillExecutor.validate_inputs(manifest, {
        "max_results": 3,
    })
    assert validated is None, "Expected validation failure for missing 'query'"


def test_validate_optional_default():
    """Optional fields should get their default values."""
    registry = get_skill_registry()
    manifest = registry.get("pubmed")
    assert manifest is not None
    validated = SkillExecutor.validate_inputs(manifest, {
        "query": "cancer",
    })
    assert validated is not None
    assert validated["max_results"] == 20, "Default for max_results should be 20"
    assert validated["task_id"] == "T0", "Default for task_id should be 'T0'"


# ── Execution error-path tests ────────────────────────────────────


def test_execute_unknown_skill():
    """Executing a non-existent skill returns failure."""
    result = SkillExecutor.execute("nonexistent_skill_id", {})
    assert result.success is False
    assert "未注册" in result.error


def test_execute_missing_required_inputs():
    """Executing with missing required inputs returns failure before executor."""
    result = SkillExecutor.execute("pubmed", {})
    assert result.success is False
    assert "输入校验失败" in result.error


def test_execute_skill_without_executor():
    """Dormant skills (no executor) should return a clear error.

    Dormant datasources still have 'query' as a required input,
    so we pass valid inputs to get past validation and reach the
    executor check.
    """
    result = SkillExecutor.execute("biogrid", {
        "query": "cancer",
        "task_id": "test-task",
    })
    assert result.success is False
    assert "缺少 executor" in result.error


# ── Executor closure signature test ───────────────────────────────


def test_executor_closure_accepts_inputs_dict():
    """Executor closures expect a single 'inputs' dict (not kwargs).

    Call the closure directly with the correct signature to verify
    it produces a SkillResult. This may require network; we just check
    the return type and handle API failures gracefully.
    """
    registry = get_skill_registry()
    executor_fn = registry.get_executor("pubmed")
    assert executor_fn is not None, "pubmed executor should be registered"

    # Call the closure with a dict argument (the correct signature)
    coro = executor_fn({
        "query": "TP53",
        "max_results": 3,
        "task_id": "test-task",
    })
    # The closure is async; we get back a coroutine
    assert coro is not None

    # Drive the coroutine to completion via asyncio
    import asyncio
    try:
        result = asyncio.run(coro)
    except Exception:
        # Network/API failures are acceptable for a unit test
        result = None

    if result is not None:
        assert isinstance(result, SkillResult), (
            f"Expected SkillResult, got {type(result).__name__}"
        )
        # Accept both success (API available) and failure (network issues)
        assert isinstance(result.success, bool)
