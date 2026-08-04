"""Source-relation endpoint and evidence checks."""
from __future__ import annotations

from app.pipeline.stages.validation.checks_common import ValidationContext, read_csv


def check_source_relation_evidence(ctx: ValidationContext) -> dict[str, object]:
    relation_path = ctx.staging / "source_relations.csv"
    relation_rows = read_csv(relation_path) if relation_path.is_file() else []
    relation_ids: set[str] = set()
    failures = 0
    for row in relation_rows:
        relation_id = row.get("relation_id", "")
        duplicate_id = not relation_id or relation_id in relation_ids
        relation_ids.add(relation_id)
        evidence_type = row.get("evidence_type", "")
        evidence_value = row.get("evidence_value", "")
        evidence_url = row.get("evidence_url", "")
        from_source = ctx.sources_by_id.get(row.get("from_source_id", ""))
        to_source = ctx.sources_by_id.get(row.get("to_source_id", ""))
        valid = False
        if row.get("relation_type") == "article_describes_dataset":
            valid = bool(
                from_source
                and to_source
                and from_source.get("database") == "pubmed"
                and to_source.get("database") == "geo"
                and evidence_type == "geo_pubmed_id"
                and evidence_value == from_source.get("accession")
                and evidence_url == to_source.get("url")
            )
        elif row.get("relation_type") == "geo_references_pubmed":
            valid = bool(
                from_source
                and from_source.get("database") == "geo"
                and row.get("to_source_id") == f"ext:pubmed:{evidence_value}"
                and evidence_type == "geo_pubmed_id"
                and evidence_value
                and evidence_url == from_source.get("url")
            )
        failures += int(duplicate_id or not valid)
    return {
        "check_id": "source_relation_evidence",
        "scope": "source_relations",
        "check_name": "source relation endpoints and evidence close",
        "status": "passed" if failures == 0 else "failed",
        "checked_count": len(relation_rows),
        "failed_count": failures,
        "details": "",
    }
