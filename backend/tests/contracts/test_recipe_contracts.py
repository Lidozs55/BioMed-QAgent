from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.domain.contracts import (
    ApiRequestStep,
    BrowserActionStep,
    HtmlExtractStep,
    RecipeAttempt,
    RecipeStatus,
    WorkflowRecipe,
)
from pydantic import TypeAdapter, ValidationError

NOW = datetime(2026, 7, 29, tzinfo=UTC)


def test_recipe_step_union_is_discriminated_by_type() -> None:
    adapter = TypeAdapter(WorkflowRecipe.model_fields["steps"].annotation)

    steps = adapter.validate_python(
        [
            {
                "type": "api_request",
                "url_template": "https://api.example.org/{accession}",
            },
            {
                "type": "html_extract",
                "url_template": "https://example.org/{accession}",
                "selectors": {"download": "a.download"},
            },
            {
                "type": "browser_action",
                "action": "click",
                "target": "a.download",
            },
        ]
    )

    assert isinstance(steps[0], ApiRequestStep)
    assert isinstance(steps[1], HtmlExtractStep)
    assert isinstance(steps[2], BrowserActionStep)


@pytest.mark.parametrize(
    "action",
    ["navigate", "click", "fill", "select", "wait_for", "extract"],
)
def test_browser_action_allowlist_accepts_declared_actions(action: str) -> None:
    step = BrowserActionStep(type="browser_action", action=action)

    assert step.action == action


def test_browser_action_rejects_executable_script_action() -> None:
    with pytest.raises(ValidationError):
        BrowserActionStep(
            type="browser_action",
            action="evaluate",
            value="window.localStorage",
        )


def test_recipe_contract_rejects_arbitrary_code_fields() -> None:
    with pytest.raises(ValidationError):
        WorkflowRecipe.model_validate(
            {
                **_recipe().model_dump(mode="json"),
                "code": "import os",
            }
        )


def test_recipe_contract_rejects_nested_executable_fields() -> None:
    with pytest.raises(ValidationError, match="executable"):
        WorkflowRecipe.model_validate(
            {
                **_recipe().model_dump(mode="json"),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "payload": {
                            "type": "object",
                            "code": "import os",
                        }
                    },
                },
            }
        )


def test_recipe_attempt_rejects_reversed_timestamps() -> None:
    with pytest.raises(ValidationError, match="finished_at"):
        RecipeAttempt(
            method="api",
            url="https://api.example.org/data",
            status="failed",
            started_at=NOW,
            finished_at=NOW - timedelta(seconds=1),
            reason="timeout",
        )


def _recipe() -> WorkflowRecipe:
    return WorkflowRecipe(
        recipe_id="recipe_geo",
        created_at=NOW,
        generated_by_model="qwen-plus",
        domain="gene-expression",
        capability="download-series-matrix",
        allowed_hosts=["api.example.org"],
        input_schema={
            "type": "object",
            "properties": {"accession": {"type": "string"}},
            "required": ["accession"],
        },
        steps=[
            ApiRequestStep(
                type="api_request",
                url_template="https://api.example.org/{accession}",
            )
        ],
        status=RecipeStatus.DRAFT,
    )
