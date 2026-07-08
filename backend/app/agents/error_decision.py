"""Error Decision Agent — LLM 驱动的流水线错误决策。

当 PIPELINE 阶段执行失败时，由 LLM 决定：
- retry: 重试该阶段（最多 2 次）
- skip_stage: 跳过失败阶段，继续执行后续阶段
- escalate: 记录警告但继续执行（非致命错误）
- fail: 终止流水线（致命错误）

设计原则：
- 规则级判断优先（LLM 不可用时也能工作）
- LLM 兜底（理解错误语义，做出更智能的决策）
- 每阶段最多重试 2 次，避免死循环
"""
from __future__ import annotations

import logging
from typing import Any

from app.agents.base import BaseAgent, ProgressCallback
from app.agents.registry import AgentRegistry
from app.config import MODEL_STRONG
from app.models.task import Task

logger = logging.getLogger(__name__)

MAX_RETRIES_PER_STAGE = 2


@AgentRegistry.register
class ErrorDecisionAgent(BaseAgent):
    name = "error_decision"
    description = "LLM 驱动的流水线错误决策（retry / skip / escalate / fail）"

    async def execute(self, task: Task, records: list[dict],
                      context: dict,
                      progress: ProgressCallback | None = None) -> tuple[list[dict], dict]:
        """ErrorDecisionAgent 不参与流水线阶段调度，通过 decide() 直接调用。

        此方法为满足 BaseAgent ABC 要求而提供，不应被直接调用。
        """
        raise NotImplementedError(
            "ErrorDecisionAgent 不通过 execute() 调度，"
            "请使用 decide() 方法进行错误决策")

    async def decide(self, task: Task, stage_name: str,
                     error: Exception, records: list[dict],
                     context: dict, retry_count: int,
                     progress: ProgressCallback | None = None) -> dict:
        """决定如何处理流水线阶段失败。

        Args:
            task: 当前任务
            stage_name: 失败的阶段名 (search/acquire/parse/clean/analyze/review)
            error: 捕获的异常
            records: 当前记录列表
            context: 共享上下文
            retry_count: 该阶段已重试次数
            progress: 可选进度回调

        Returns:
            decision dict: {
                "action": "retry" | "skip_stage" | "escalate" | "fail",
                "reason": "决策理由",
                "retry_advice": "重试建议（仅 retry 时有意义）",
                "escalation_message": "升级消息（仅 escalate 时有意义）"
            }
        """
        # 1. 规则级硬性判断（无需 LLM）
        decision = self._rule_based_decision(stage_name, error, retry_count)
        if decision is not None:
            self._emit(progress, type="error_decision",
                        stage=stage_name, **decision)
            return decision

        # 2. LLM 驱动决策
        if self.llm.is_available():
            decision = await self._llm_decide(
                task, stage_name, error, records, context,
                retry_count, progress)
        else:
            decision = self._fallback_decision(stage_name, error, retry_count)

        self._emit(progress, type="error_decision",
                    stage=stage_name, **decision)
        return decision

    # ========== 规则级决策 ==========

    @staticmethod
    def _rule_based_decision(stage_name: str, error: Exception,
                              retry_count: int) -> dict | None:
        """规则级硬性判断，无需 LLM。返回 decision 或 None（需要 LLM 判断）。"""
        error_msg = str(error)

        # 条件 1: 重试已达上限 → escalate（尝试继续）而非 fail
        if retry_count >= MAX_RETRIES_PER_STAGE:
            return {
                "action": "escalate",
                "reason": f"阶段 {stage_name} 已重试 {retry_count} 次（上限 {MAX_RETRIES_PER_STAGE}），跳过继续",
                "retry_advice": "",
                "escalation_message": error_msg[:200],
            }

        # 条件 2: 明显的临时性错误 → 自动 retry
        transient_patterns = [
            "timeout", "connection", "rate limit", "429", "503",
            "temporary", "try again", "retry", "throttl",
        ]
        for pat in transient_patterns:
            if pat.lower() in error_msg.lower():
                return {
                    "action": "retry",
                    "reason": f"检测到临时性错误模式 '{pat}'，自动重试",
                    "retry_advice": "等待短暂延迟后重试",
                    "escalation_message": "",
                }

        # 条件 3: review 阶段失败 → escalate（审查失败不应阻止导出）
        if stage_name == "review":
            return {
                "action": "escalate",
                "reason": "review 阶段失败不阻止流水线，直接导出",
                "retry_advice": "",
                "escalation_message": error_msg[:200],
            }

        # 条件 4: 明显的永久性错误 → fail
        permanent_patterns = [
            "api key", "unauthorized", "403", "not found", "404",
            "invalid", "not configured", "not available",
        ]
        for pat in permanent_patterns:
            if pat.lower() in error_msg.lower():
                return {
                    "action": "fail",
                    "reason": f"检测到永久性错误模式 '{pat}'，终止流水线",
                    "retry_advice": "",
                    "escalation_message": "",
                }

        return None  # 需 LLM 判断

    # ========== LLM 驱动决策 ==========

    async def _llm_decide(self, task: Task, stage_name: str,
                          error: Exception, records: list[dict],
                          context: dict, retry_count: int,
                          progress: ProgressCallback | None) -> dict:
        """调用 LLM 进行语义级错误决策。"""
        error_msg = str(error)[:500]
        error_type = type(error).__name__
        entities = context.get("entities", {})
        stage_order = ["search", "acquire", "parse", "clean", "analyze", "review"]

        prompt = f"""你是生物医学数据流水线的错误决策专家。流水线的某个阶段执行失败，请决定如何处理。

研究目标：{task.research_goal}
失败阶段：{stage_name}（流水线位置：{stage_order.index(stage_name) + 1}/{len(stage_order)}）
错误类型：{error_type}
错误信息：{error_msg}
已重试次数：{retry_count}（上限 {MAX_RETRIES_PER_STAGE}）
当前记录数：{len(records)}

已识别实体：
- 基因：{entities.get('genes', [])[:5]}
- 化合物：{entities.get('compounds', [])[:5]}

请判断最佳处理方式，返回严格 JSON：
{{
  "action": "retry | skip_stage | escalate | fail",
  "reason": "决策理由（中文，30 字内）",
  "retry_advice": "重试建议（仅 retry 时填写）",
  "escalation_message": "升级消息（仅 escalate 时填写）"
}}

决策指南：
- retry: 错误可能是暂时性的（网络波动、API 限流），重试可能成功。条件：retry_count < {MAX_RETRIES_PER_STAGE}
- skip_stage: 该阶段可有可无（如 acquire 阶段），跳过不影响最终结果质量
- escalate: 错误不严重（如 review 阶段），降级继续，避免中断整个流水线
- fail: 核心阶段（search/parse/clean）的永久性错误，继续无意义

注意：
- search 是核心阶段，只有明确临时错误才 retry，永久错误直接 fail
- acquire 阶段可 skip（解析上游记录即可）
- review 阶段应 escalate（审查失败不应阻止报告生成）
- 已重试 {retry_count} 次，若达上限则应考虑 escalate 而非 fail
"""

        try:
            result = await self._to_thread(
                self.llm.chat_json,
                [{"role": "user", "content": prompt}],
                model=MODEL_STRONG,
                temperature=0.3,
            )
            return {
                "action": result.get("action", "fail"),
                "reason": result.get("reason", ""),
                "retry_advice": result.get("retry_advice", ""),
                "escalation_message": result.get("escalation_message", ""),
            }
        except Exception as llm_err:
            logger.warning("LLM 错误决策失败: %s，使用 fallback", llm_err)
            return self._fallback_decision(stage_name, error, retry_count)

    # ========== Fallback 决策（无 LLM 时） ==========

    @staticmethod
    def _fallback_decision(stage_name: str, error: Exception,
                            retry_count: int) -> dict:
        """无 LLM 时的保守 fallback：按阶段类型决策。"""
        error_msg = str(error)

        # 核心阶段：先 retry
        core_stages = {"search", "parse", "clean", "analyze"}
        if stage_name in core_stages and retry_count < MAX_RETRIES_PER_STAGE:
            return {
                "action": "retry",
                "reason": f"核心阶段 {stage_name} 失败，自动重试（{retry_count + 1}/{MAX_RETRIES_PER_STAGE}）",
                "retry_advice": "检查网络连接后重试",
                "escalation_message": "",
            }

        # review 阶段：escalate
        if stage_name == "review":
            return {
                "action": "escalate",
                "reason": "review 阶段失败，降级继续",
                "retry_advice": "",
                "escalation_message": error_msg[:200],
            }

        # acquire 阶段：skip
        if stage_name == "acquire":
            return {
                "action": "skip_stage",
                "reason": "acquire 阶段失败，跳过爬虫继续",
                "retry_advice": "",
                "escalation_message": "",
            }

        # 默认 fail
        return {
            "action": "fail",
            "reason": f"阶段 {stage_name} 失败，终止流水线: {error_msg[:80]}",
            "retry_advice": "",
            "escalation_message": "",
        }
