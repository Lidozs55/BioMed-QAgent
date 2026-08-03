"""Public model configuration schemas and catalogs."""

from .catalog import (
    QWEN_MODELS_DB,
    augment_capabilities,
    get_advanced_defaults,
    get_known_model,
    infer_capabilities,
    list_known_models,
)
from .context_budget import ContextBudget, ContextBudgetOverflowError
from .schemas import (
    AdvancedParams,
    Capabilities,
    QwenModelEntry,
    RunModelSettings,
    RuntimeLimitsSettings,
    UserSettings,
)

__all__ = [
    "AdvancedParams",
    "Capabilities",
    "ContextBudget",
    "ContextBudgetOverflowError",
    "QWEN_MODELS_DB",
    "QwenModelEntry",
    "RunModelSettings",
    "RuntimeLimitsSettings",
    "UserSettings",
    "augment_capabilities",
    "get_advanced_defaults",
    "get_known_model",
    "infer_capabilities",
    "list_known_models",
]
