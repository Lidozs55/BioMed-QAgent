from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.domain.contracts import (
    Database,
    DatasetSelection,
    QuerySpecification,
    RequestedOutput,
    TaskRequest,
    TaskSpecification,
)


def test_task_request_requires_only_topic_and_uses_approved_defaults() -> None:
    request = TaskRequest(topic="  breast cancer gene expression  ")

    assert request.topic == "breast cancer gene expression"
    assert request.databases == [Database.PUBMED, Database.GEO]
    assert request.keywords == []
    assert request.target_fields == []


def test_task_request_rejects_blank_topic_and_extra_fields() -> None:
    with pytest.raises(ValidationError, match="topic"):
        TaskRequest(topic="   ")
    with pytest.raises(ValidationError, match="extra_forbidden"):
        TaskRequest(topic="test", preferred_sources=["geo"])


def test_query_specification_preserves_explicit_order_and_origin() -> None:
    query = QuerySpecification(
        query_id="query_geo_1",
        database=Database.GEO,
        query="breast cancer AND tximport",
        generated_by="agent",
        purpose="find expression datasets",
        order=1,
        max_results=20,
    )

    assert query.order == 1
    assert query.page_size is None


@pytest.mark.parametrize("field,value", [("order", 0), ("page_size", 0), ("max_results", -1)])
def test_query_specification_rejects_non_positive_execution_numbers(
    field: str, value: int
) -> None:
    payload = {
        "query_id": "query_geo_1",
        "database": Database.GEO,
        "query": "test",
        "generated_by": "pipeline",
        "purpose": "test",
        "order": 1,
        field: value,
    }

    with pytest.raises(ValidationError):
        QuerySpecification(**payload)


def test_task_specification_is_data_requirements_not_executable_code() -> None:
    specification = TaskSpecification(
        topic="breast cancer",
        queries=[
            QuerySpecification(
                query_id="query_pubmed_1",
                database=Database.PUBMED,
                query="breast cancer",
                generated_by="user",
                purpose="literature discovery",
                order=1,
            )
        ],
        datasets=[
            DatasetSelection(
                dataset_id="ds_geo_gse178352",
                database=Database.GEO,
                accession="GSE178352",
                reason="linked from PMID 34180400",
            )
        ],
        requested_outputs=[RequestedOutput.MAIN_DATA],
    )

    assert specification.datasets[0].accession == "GSE178352"
    with pytest.raises(ValidationError, match="extra_forbidden"):
        TaskSpecification(**specification.model_dump(), executable_code="print('no')")
