"""Public model configuration schemas, catalogs, and vendor helpers."""

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
    UserSettings,
)
from .vendors import VENDORS, Vendor, get_vendors, list_vendors

__all__ = [
    "AdvancedParams",
    "Capabilities",
    "ContextBudget",
    "ContextBudgetOverflowError",
    "QWEN_MODELS_DB",
    "QwenModelEntry",
    "RunModelSettings",
    "UserSettings",
    "VENDORS",
    "Vendor",
    "augment_capabilities",
    "get_advanced_defaults",
    "get_known_model",
    "get_vendors",
    "infer_capabilities",
    "list_known_models",
    "list_vendors",
]
