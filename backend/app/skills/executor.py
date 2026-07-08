"""技能执行器 — SkillResult 结果模型 + SkillExecutor 校验&执行引擎。

提供统一的技能执行接口：根据 SkillManifest 校验输入，
再委托给注册的 executor 闭包执行。
"""
from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from app.skills.manifest import SkillManifest

logger = logging.getLogger(__name__)


# ═══ SkillResult ─────────────────────────────────────────────────


class SkillResult:
    """技能执行结果。镜像 ToolResult 但增加 metrics 字段。"""

    def __init__(
        self,
        success: bool,
        data=None,
        error: str = "",
        metrics: dict | None = None,
    ) -> None:
        self.success = success
        self.data = data
        self.error = error
        self.metrics = metrics or {}

    def __repr__(self) -> str:
        if self.success:
            return "SkillResult(ok)"
        return f"SkillResult(fail: {self.error[:80]})"


# ═══ SkillExecutor ───────────────────────────────────────────────


class SkillExecutor:
    """校验输入是否符合 SkillManifest，委托给 executor 闭包执行。

    仅使用 classmethod 接口（与 SkillRegistry 风格一致）。
    """

    @classmethod
    def execute(
        cls,
        skill_id: str,
        inputs: dict,
        registry=None,
    ) -> SkillResult:
        """执行一个技能。

        Args:
            skill_id: 技能唯一标识（如 pubmed）
            inputs: 用户传入的参数字典
            registry: SkillRegistry 类或等效接口（默认 None，
                      内部会惰性导入 SkillRegistry）

        Returns:
            SkillResult(success=True, data=...) 或
            SkillResult(success=False, error=...)
        """
        if registry is None:
            from app.skills.registry import SkillRegistry
            registry = SkillRegistry

        # 1. 查清单
        manifest: SkillManifest | None = registry.get(skill_id)
        if manifest is None:
            msg = f"技能 {skill_id!r} 未注册"
            logger.warning(msg)
            return SkillResult(False, error=msg)

        # 2. 校验输入
        validated = cls.validate_inputs(manifest, inputs)
        if validated is None:
            return SkillResult(False, error=f"技能 {skill_id!r} 输入校验失败")

        # 3. 获取 executor 闭包
        executor_fn = registry.get_executor(skill_id)
        if executor_fn is None:
            msg = f"技能 {skill_id!r} 缺少 executor"
            logger.warning(msg)
            return SkillResult(False, error=msg)

        # 4-5. 执行 → 包装 → 异常兜底
        try:
            result = executor_fn(**validated)
            return SkillResult(True, data=result)
        except Exception as exc:
            logger.exception("技能 %r 执行异常", skill_id)
            return SkillResult(False, error=str(exc))

    @classmethod
    def validate_inputs(
        cls,
        manifest: SkillManifest,
        inputs: dict,
    ) -> dict | None:
        """校验输入是否符合 SkillManifest.inputs 规格。

        - 检查所有 required 字段是否存在于 inputs 中
        - 为缺失的 optional 字段填充 manifest 中的 default
        - 返回校验后的 dict；若任何必填字段缺失则返回 None
        """
        validated: dict[str, Any] = {}

        for field in manifest.inputs:
            if field.required:
                if field.name not in inputs:
                    logger.warning(
                        "技能 %r 缺少必填字段 %r", manifest.skill_id, field.name,
                    )
                    return None
                validated[field.name] = inputs[field.name]
            else:
                validated[field.name] = inputs.get(field.name, field.default)

        return validated
