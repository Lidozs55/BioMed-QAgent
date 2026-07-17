"""Live test for minimal Qwen TaskSpecification generation (TODO §10.2 line 322).

Verifies that the Qwen model (via DashScope OpenAI-compatible endpoint) can
produce a structurally valid TaskSpecification JSON when given a research
topic. The test only validates schema conformance, not semantic correctness.

This test is marked ``@pytest.mark.live`` and excluded from the default
suite. Run explicitly with::

    uv run pytest -m live tests/live/test_qwen_task_spec_live.py -v
"""
from __future__ import annotations

import json

import pytest
from app.config import settings
from app.domain.contracts import TaskSpecification
from openai import AsyncOpenAI

pytestmark = pytest.mark.live


def _build_spec_prompt(topic: str) -> str:
    """Construct a prompt that asks the model to output TaskSpecification JSON."""
    return f"""\
You are a biomedical research assistant. Given a research topic, output a JSON
object that conforms to the following specification.

Output ONLY valid JSON, no markdown code fences, no explanation.

Schema:
- topic: string (the research topic)
- queries: array of objects:
    - query_id: string (unique id like "query_1")
    - database: string (one of: "pubmed", "geo")
    - query: string (the database query string)
    - generated_by: string (must be "agent")
    - purpose: string (why this query is needed)
    - order: integer (1-based ordering)
- datasets: array of objects:
    - dataset_id: string (unique id like "dataset_1")
    - database: string (one of: "pubmed", "geo")
    - accession: string (database accession number)
    - source_id: string or null (source record id, may be null)
    - reason: string (why this dataset was selected)
- requested_outputs: array of strings (items from:
  "main_data", "literature", "dataset_catalog", "sample_metadata")

Research topic: {topic}
"""


@pytest.mark.asyncio
async def test_qwen_generates_valid_task_specification() -> None:
    """Qwen must return parseable JSON that passes TaskSpecification validation."""
    assert settings.dashscope_api_key, "DASHSCOPE_API_KEY is required for live test"
    client = AsyncOpenAI(
        api_key=settings.dashscope_api_key,
        base_url=settings.dashscope_base_url,
    )

    try:
        topic = "breast cancer gene expression profiling"
        prompt = _build_spec_prompt(topic)

        response = await client.chat.completions.create(
            model=settings.model_name,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
        )

        text = response.choices[0].message.content or ""

        text = text.strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:].strip()

        data = json.loads(text)
        assert isinstance(data, dict), "model output must be a JSON object"

        spec = TaskSpecification(**data)
        assert spec.topic == topic
        assert len(spec.queries) >= 1
        assert all(q.generated_by == "agent" for q in spec.queries)
        assert all(q.order > 0 for q in spec.queries)
    finally:
        await client.close()
