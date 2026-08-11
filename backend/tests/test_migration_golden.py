"""Executable golden baseline for the Phase 0/1 Pi migration."""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_migration_golden.py"
GOLDEN_ROOT = REPO_ROOT / "tests" / "migration" / "golden"
OUTCOMES = ("succeeded", "partial_success", "no_data", "spec_rejected")


def _load_verifier() -> ModuleType:
    spec = importlib.util.spec_from_file_location("verify_migration_golden", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_golden_fixture_set_is_complete() -> None:
    expected = [SCRIPT_PATH, GOLDEN_ROOT / "contract-snapshot.json"]
    expected.extend(GOLDEN_ROOT / outcome / "fixture.json" for outcome in OUTCOMES)

    missing = [path.relative_to(REPO_ROOT).as_posix() for path in expected if not path.is_file()]
    assert missing == [], f"missing Phase 0D golden fixtures: {missing}"


def test_capture_is_deterministic_and_matches_committed_files() -> None:
    verifier = _load_verifier()

    first = verifier.capture_documents()
    second = verifier.capture_documents()

    assert first == second
    assert verifier.verify_committed_documents(first) == []


@pytest.mark.parametrize("outcome", OUTCOMES)
def test_outcome_fixture_uses_current_contracts_and_valid_hashes(outcome: str) -> None:
    verifier = _load_verifier()

    fixture = verifier.load_and_validate_fixture(outcome)

    assert fixture["outcome"] == outcome
    assert verifier.verify_referenced_hashes(fixture) == []


def test_no_data_and_spec_rejected_encode_absent_outputs_explicitly() -> None:
    for outcome in ("no_data", "spec_rejected"):
        fixture = json.loads((GOLDEN_ROOT / outcome / "fixture.json").read_text("utf-8"))
        assert fixture["validation_result"] is None
        assert fixture["manifest"] is None
        assert fixture["publication"] is None
        assert fixture["artifact_fixtures"] == []


def test_event_samples_preserve_run_completed_business_outcomes() -> None:
    verifier = _load_verifier()

    for outcome in OUTCOMES:
        fixture = verifier.load_and_validate_fixture(outcome)
        event = fixture["event_envelope"]
        assert event["schema_version"] == "2.0"
        assert event["type"] == "run_completed"
        assert event["run_id"]
        assert event["payload"]["build_result"] == fixture["build_result"]


def test_canonicalization_ignores_only_allowed_volatile_fields() -> None:
    verifier = _load_verifier()
    fixture = json.loads((GOLDEN_ROOT / "succeeded" / "fixture.json").read_text("utf-8"))

    volatile = copy.deepcopy(fixture)
    volatile["event_envelope"]["event_id"] = "event_random"
    volatile["event_envelope"]["timestamp"] = "2099-01-01T00:00:00Z"
    volatile["publication"]["published_at"] = "2099-01-01T00:00:00Z"
    volatile["build_result"]["user_summary"] = "different generated prose"
    assert verifier.canonicalize(volatile) == verifier.canonicalize(fixture)

    business_drift = copy.deepcopy(fixture)
    business_drift["build_result"]["status"] = "partial_success"
    assert verifier.canonicalize(business_drift) != verifier.canonicalize(fixture)
