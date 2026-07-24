"""Tripo 3D model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "Tripo/Tripo-H3.1": ModelDetail(
        id="Tripo/Tripo-H3.1",
        name="Tripo H3.1",
        description="Tripo 3D 生成模型 H3.1。",
        vendor_id="tripo",
        input_context_window=1,
        max_output_tokens=1,
        suggested_max_tokens=1,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2026-06",
        model_family="tripo",
    ),
    "Tripo/Tripo-P1.0": ModelDetail(
        id="Tripo/Tripo-P1.0",
        name="Tripo P1.0",
        description="Tripo 3D 生成模型 P1.0。",
        vendor_id="tripo",
        input_context_window=1,
        max_output_tokens=1,
        suggested_max_tokens=1,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2026-06",
        model_family="tripo",
    ),
}

def register(target: dict[str, ModelDetail]) -> None:
    """Merge Tripo models into the target repository dictionary."""
    target.update(MODELS)
