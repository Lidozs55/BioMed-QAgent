"""Tests for ErrorDecisionAgent."""
from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from app.agents.error_decision import ErrorDecisionAgent, MAX_RETRIES_PER_STAGE
from app.agents.registry import AgentRegistry, register_all_agents
from app.models.task import Task


@pytest.fixture
def sample_task():
    return Task(
        research_goal="分析TP53在胰腺癌中的作用",
        domain_hint="oncology",
    )


@pytest.fixture
def error_agent():
    register_all_agents()
    agent = ErrorDecisionAgent()
    return agent


class TestRuleBasedDecision:
    """测试规则级决策（无需 LLM）"""

    def test_retry_limit_reached_escalates(self, error_agent, sample_task):
        """重试达上限 → escalate"""
        result = error_agent._rule_based_decision(
            "search", Exception("timeout"), MAX_RETRIES_PER_STAGE)
        assert result is not None
        assert result["action"] == "escalate"

    def test_transient_error_retries(self, error_agent, sample_task):
        """临时性错误 → retry"""
        for msg in ["connection timeout", "rate limit exceeded",
                     "503 Service Unavailable", "temporary failure"]:
            result = error_agent._rule_based_decision(
                "search", Exception(msg), 0)
            assert result is not None, f"Should match '{msg}'"
            assert result["action"] == "retry", f"'{msg}' should trigger retry"

    def test_permanent_error_fails(self, error_agent, sample_task):
        """永久性错误 → fail"""
        for msg in ["api key invalid", "403 Forbidden",
                     "not found", "unauthorized"]:
            result = error_agent._rule_based_decision(
                "search", Exception(msg), 0)
            assert result is not None, f"Should match '{msg}'"
            assert result["action"] == "fail", f"'{msg}' should trigger fail"

    def test_review_stage_escalates(self, error_agent, sample_task):
        """review 阶段失败 → escalate"""
        result = error_agent._rule_based_decision(
            "review", Exception("LLM quota exceeded"), 0)
        assert result is not None
        assert result["action"] == "escalate"

    def test_unknown_error_returns_none(self, error_agent, sample_task):
        """不匹配任何规则 → None（需 LLM）"""
        result = error_agent._rule_based_decision(
            "parse", Exception("unexpected field format in record"), 0)
        assert result is None


class TestFallbackDecision:
    """测试无 LLM 时的 fallback 决策"""

    def test_core_stage_fallback_retries(self, error_agent, sample_task):
        for stage in ["search", "parse", "clean", "analyze"]:
            result = error_agent._fallback_decision(
                stage, Exception("some error"), 0)
            assert result["action"] == "retry", f"{stage} should retry"

    def test_core_stage_at_limit_fails(self, error_agent, sample_task):
        result = error_agent._fallback_decision(
            "search", Exception("some error"), MAX_RETRIES_PER_STAGE)
        assert result["action"] == "fail"

    def test_review_fallback_escalates(self, error_agent, sample_task):
        result = error_agent._fallback_decision(
            "review", Exception("some error"), 0)
        assert result["action"] == "escalate"

    def test_acquire_fallback_skips(self, error_agent, sample_task):
        result = error_agent._fallback_decision(
            "acquire", Exception("crawl failed"), 0)
        assert result["action"] == "skip_stage"


class TestDecideFull:
    """测试完整 decide() 流程"""

    def test_decide_rule_based_short_circuit(self, error_agent, sample_task):
        """规则命中时，不调用 LLM"""
        decision = asyncio.run(error_agent.decide(
            sample_task, "search", Exception("connection timeout"),
            [], {}, 0))
        assert decision["action"] == "retry"

    def test_decide_fallback_when_no_llm(self, error_agent, sample_task):
        """无 LLM 时使用 fallback"""
        error_agent.llm = MagicMock()
        error_agent.llm.is_available.return_value = False
        decision = asyncio.run(error_agent.decide(
            sample_task, "parse", Exception("weird parse error"),
            [], {}, 0))
        assert decision["action"] == "retry"  # parse is core stage


class TestAgentRegistration:
    """测试 ErrorDecisionAgent 注册"""

    def test_registered_in_agent_registry(self, error_agent):
        register_all_agents()
        assert AgentRegistry.has("error_decision")

    def test_get_from_registry(self, error_agent):
        agent = AgentRegistry.get("error_decision")
        assert agent is not None
        assert agent.name == "error_decision"
