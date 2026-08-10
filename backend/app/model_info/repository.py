"""ModelInfoRepository — data warehouse for comprehensive model metadata.

This module provides a singleton repository that aggregates model
information from all provider-specific modules and exposes rich
lookup, filtering, and query capabilities.

Usage::

    repo = ModelInfoRepository()
    detail = repo.get_model("qwen-plus")
    all_models = repo.list_models()
    qwen_models = repo.list_models(vendor="dashscope")
    vision_models = repo.list_models(capability="image")
"""

from __future__ import annotations

import logging
from functools import lru_cache

from .providers import (
    _register_baichuan,
    _register_deepseek,
    _register_groq,
    _register_kuaishou,
    _register_minimax,
    _register_mistral,
    _register_moonshot,
    _register_openai,
    _register_qwen,
    _register_tripo,
    _register_xai,
    _register_zhipu,
)
from .schemas import ModelCapabilities, ModelDetail

logger = logging.getLogger(__name__)


class ModelInfoRepository:
    """Aggregate model information warehouse.

    The repository loads model data from all registered provider modules at
    construction time and provides a uniform lookup / filtering interface.
    It is designed as a cheap, stateless object that can be instantiated
    on demand or cached as a singleton in the FastAPI lifespan.
    """

    def __init__(self) -> None:
        self._models: dict[str, ModelDetail] = {}
        self._load_all()

    # ------------------------------------------------------------------
    # Internal: load from providers
    # ------------------------------------------------------------------

    def _load_all(self) -> None:
        """Load model data from all registered provider modules."""
        registrars = [
            _register_qwen,
            _register_openai,
            _register_deepseek,
            _register_moonshot,
            _register_zhipu,
            _register_baichuan,
            _register_groq,
            _register_xai,
            _register_mistral,
        _register_minimax,
        _register_kuaishou,
        _register_tripo,
        ]
        for register_fn in registrars:
            try:
                register_fn(self._models)
            except Exception:
                logger.exception(
                    "Failed to load model provider %s",
                    register_fn.__module__,
                )
        loaded = len(self._models)
        logger.info(
            "ModelInfoRepository loaded %d models from %d providers",
            loaded,
            len(registrars),
        )

    # ------------------------------------------------------------------
    # Public query API
    # ------------------------------------------------------------------

    def get_model(self, model_id: str) -> ModelDetail | None:
        """Look up a single model by its canonical identifier.

        Returns ``None`` when the identifier is not in the warehouse.
        """
        return self._models.get(model_id)

    def get_model_or_raise(self, model_id: str) -> ModelDetail:
        """Like ``get_model`` but raises ``KeyError`` on miss."""
        entry = self.get_model(model_id)
        if entry is None:
            raise KeyError(model_id)
        return entry

    def list_models(
        self,
        *,
        vendor: str | None = None,
        capability: str | None = None,
        recommended_only: bool = False,
    ) -> list[ModelDetail]:
        """Return models, optionally filtered by vendor, capability, or recommendation.

        Parameters
        ----------
        vendor : str | None
            If set, only return models matching this ``vendor_id``.
        capability : str | None
            If set, only return models that support this modality
            (one of ``"text"``, ``"image"``, ``"video"``, ``"audio"``).
        recommended_only : bool
            If ``True``, only return models marked as ``recommended=True``.

        Returns
        -------
        list[ModelDetail]
            Models sorted by (not recommended, vendor, id).
        """
        results: list[ModelDetail] = []
        for model in self._models.values():
            if vendor is not None and model.vendor_id != vendor:
                continue
            if capability is not None and not _supports_capability(
                model.capabilities, capability
            ):
                continue
            if recommended_only and not model.recommended:
                continue
            results.append(model)
        results.sort(key=lambda m: (not m.recommended, m.vendor_id, m.id))
        return results

    def list_vendors(self) -> list[str]:
        """Return sorted, deduplicated vendor identifiers present in the warehouse."""
        return sorted({m.vendor_id for m in self._models.values()})

    def list_by_family(self, family: str) -> list[ModelDetail]:
        """Return all models belonging to a model family."""
        return [m for m in self._models.values() if m.model_family == family]

    def search(self, query: str) -> list[ModelDetail]:
        """Free-text search across model ID, name, description, and vendor."""
        q = query.casefold()
        results = []
        for model in self._models.values():
            if (
                q in model.id.casefold()
                or q in model.name.casefold()
                or q in model.description.casefold()
                or q in model.vendor_id.casefold()
            ):
                results.append(model)
        return results

    def to_flat_dicts(self) -> list[dict]:
        """Return all models as plain dicts (useful for API serialization).

        The output can be directly returned from a FastAPI endpoint or
        further post-processed.
        """
        return [model.model_dump() for model in self._models.values()]

    @property
    def count(self) -> int:
        """Total number of models in the warehouse."""
        return len(self._models)


# ------------------------------------------------------------------
# Module-level singleton (lazy)
# ------------------------------------------------------------------


@lru_cache(maxsize=1)
def get_repository() -> ModelInfoRepository:
    """Return the singleton ``ModelInfoRepository`` instance.

    This is cached after first call and should be used in FastAPI
    lifespan or route handlers that need the warehouse.
    """
    return ModelInfoRepository()


# ------------------------------------------------------------------
# Internal helpers
# ------------------------------------------------------------------


def _supports_capability(caps: ModelCapabilities, capability: str) -> bool:
    """Check whether *caps* has the named capability enabled."""
    return bool(getattr(caps, capability, False))
