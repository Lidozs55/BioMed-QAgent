"""Measurement identity primitives (Phase 5 D3; T4).

The Compatibility Gate's merge identity is the fixed ordered triple
``(value_semantics, value_scale, expression_unit)``: two sources may only be
merged when all three agree.  ``value_scale`` is a ``ValueScale`` member —
``raw_count`` is a value *semantics*, never a scale — and ``unknown`` is an
honest value that is never promoted to a known scale.

T4 owns these primitives (stable ordering + serialization); T5's gate matrix
consumes them for the cross-source identity comparison.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.datasets.contracts import ValueScale


@dataclass(frozen=True, order=True)
class MeasurementIdentity:
    """Ordered identity triple ``(value_semantics, value_scale, expression_unit)``.

    ``order=True`` yields the stable sort used by the canonicalizer's
    ``measurement_identities`` statistics and by the gate's cross-source
    comparison: identities sort by semantics, then scale value, then unit.
    """

    value_semantics: str
    value_scale: ValueScale
    expression_unit: str

    def serialize(self) -> list[str]:
        """Stable JSON-safe serialization for batch statistics (T2 format)."""
        return [self.value_semantics, self.value_scale.value, self.expression_unit]

    @classmethod
    def deserialize(cls, serialized: Sequence[str]) -> MeasurementIdentity:
        """Rebuild from a serialized triple, validating the scale is a ValueScale."""
        semantics, scale, unit = serialized
        return cls(
            value_semantics=semantics,
            value_scale=ValueScale(scale),
            expression_unit=unit,
        )
