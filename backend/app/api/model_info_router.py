"""Model information API — enriched model metadata from the information warehouse.

Endpoints:
    GET  /api/v1/model-info                → list all models in warehouse
    GET  /api/v1/model-info/{model_id}     → single model detail
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.model_info import get_repository
from app.model_info.schemas import ModelDetail

router = APIRouter(prefix="/api/v1/model-info", tags=["model_info"])


# ------------------------------------------------------------------
# API response models
# ------------------------------------------------------------------


class ModelInfoVendorResponse(BaseModel):
    id: str
    name: str
    description: str
    input_context_window: int
    max_output_tokens: int
    suggested_max_tokens: int
    capabilities: dict[str, bool]
    knowledge_cutoff: str | None
    pricing_input_per_1m: float | None
    pricing_output_per_1m: float | None
    recommended: bool
    vendor_id: str
    model_family: str | None
    function_calling: bool
    supports_streaming: bool


class ModelInfoListResponse(BaseModel):
    models: list[ModelInfoVendorResponse]
    total_count: int
    vendors: list[str]


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------


@router.get("", response_model=ModelInfoListResponse)
async def list_model_info(
    vendor: str | None = None,
    capability: str | None = None,
    recommended_only: bool = False,
    query: str | None = None,
) -> ModelInfoListResponse:
    """List all models in the information warehouse.

    Optional filters:
    - ``vendor``: filter by provider (e.g. ``dashscope``, ``openai``)
    - ``capability``: filter by modality (text, image, video, audio)
    - ``recommended_only``: only recommended models
    - ``query``: free-text search across id, name, description, vendor
    """
    repo = get_repository()
    if query:
        models = repo.search(query)
    else:
        models = repo.list_models(
            vendor=vendor,
            capability=capability,
            recommended_only=recommended_only,
        )
    return ModelInfoListResponse(
        models=[_to_response(m) for m in models],
        total_count=len(models),
        vendors=repo.list_vendors(),
    )


@router.get("/{model_id}", response_model=ModelInfoVendorResponse)
async def get_model_info(model_id: str) -> ModelInfoVendorResponse:
    """Return enriched metadata for a single model."""
    repo = get_repository()
    model = repo.get_model(model_id)
    if model is None:
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model_id}' not found in warehouse",
        )
    return _to_response(model)


# ------------------------------------------------------------------
# Internal: domain → response
# ------------------------------------------------------------------


def _to_response(model: ModelDetail) -> ModelInfoVendorResponse:
    """Convert a ``ModelDetail`` domain object to the response schema."""
    return ModelInfoVendorResponse(
        id=model.id,
        name=model.name,
        description=model.description,
        vendor_id=model.vendor_id,
        input_context_window=model.input_context_window,
        max_output_tokens=model.max_output_tokens,
        suggested_max_tokens=model.suggested_max_tokens,
        capabilities=model.capabilities.model_dump(),
        knowledge_cutoff=model.knowledge_cutoff,
        pricing_input_per_1m=model.pricing_input_per_1m,
        pricing_output_per_1m=model.pricing_output_per_1m,
        recommended=model.recommended,
        model_family=model.model_family,
        function_calling=model.function_calling,
        supports_streaming=model.supports_streaming,
    )
