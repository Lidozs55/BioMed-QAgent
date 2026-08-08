"""Measurement identity primitives tests (Phase 5 T4, spec D3).

The Compatibility Gate's merge identity is the fixed ordered triple
``(value_semantics, value_scale, expression_unit)``; ``value_scale`` is a
``ValueScale`` member and ``raw_count`` is a value *semantics*, never a
scale.  ``unknown`` is an honest value that is never promoted to a known
scale.  T5 consumes these primitives in the gate matrix.
"""

from __future__ import annotations

import pytest
from app.datasets.build.identity import MeasurementIdentity
from app.datasets.contracts import ValueScale


def test_identity_triple_members() -> None:
    identity = MeasurementIdentity(
        value_semantics="normalized_expression",
        value_scale=ValueScale.LOG2,
        expression_unit="log2_expression",
    )
    assert identity.value_semantics == "normalized_expression"
    assert identity.value_scale is ValueScale.LOG2
    assert identity.expression_unit == "log2_expression"


def test_identity_serialization_round_trip() -> None:
    """serialize()/deserialize() are inverses with the stable list form."""
    identity = MeasurementIdentity(
        value_semantics="raw_count",
        value_scale=ValueScale.LINEAR,
        expression_unit="estimated_count",
    )
    assert identity.serialize() == ["raw_count", "linear", "estimated_count"]
    assert MeasurementIdentity.deserialize(
        ["raw_count", "linear", "estimated_count"]
    ) == identity


def test_identity_stable_ordering() -> None:
    """Identities sort stably by (semantics, scale value, unit)."""
    identities = {
        MeasurementIdentity("expression_value", ValueScale.LOG2, "log2_expression"),
        MeasurementIdentity("expression_value", ValueScale.UNKNOWN, "log2_expression"),
        MeasurementIdentity("expression_value", ValueScale.LINEAR, "tpm"),
        MeasurementIdentity("raw_count", ValueScale.LINEAR, "estimated_count"),
    }
    serialized = [identity.serialize() for identity in sorted(identities)]
    assert serialized == [
        ["expression_value", "linear", "tpm"],
        ["expression_value", "log2", "log2_expression"],
        ["expression_value", "unknown", "log2_expression"],
        ["raw_count", "linear", "estimated_count"],
    ]


def test_raw_count_is_a_semantics_not_a_scale() -> None:
    """``raw_count`` must be rejected as a ValueScale (it is a semantics)."""
    with pytest.raises(ValueError):
        ValueScale("raw_count")
    with pytest.raises(ValueError):
        MeasurementIdentity.deserialize(
            ["expression_value", "raw_count", "estimated_count"]
        )


def test_unknown_scale_serializes_honestly() -> None:
    """``unknown`` stays ``unknown``; nothing promotes it to a known scale."""
    identity = MeasurementIdentity(
        value_semantics="normalized_expression",
        value_scale=ValueScale.UNKNOWN,
        expression_unit="log2_expression",
    )
    assert identity.serialize() == [
        "normalized_expression",
        "unknown",
        "log2_expression",
    ]
    assert identity.value_scale is ValueScale.UNKNOWN
