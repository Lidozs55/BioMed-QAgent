from __future__ import annotations

import re

import pytest
from pydantic import Field, ValidationError

from app.domain.contracts import (
    ContractModel,
    DataLevel,
    Database,
    asset_id_from_sha256,
    generate_prefixed_uuid,
    make_dataset_id,
    make_record_id,
    make_source_id,
)


class ExampleContract(ContractModel):
    values: list[str] = Field(default_factory=list)


def test_contracts_include_schema_version_and_forbid_extra_fields() -> None:
    contract = ExampleContract()

    assert contract.model_dump() == {"schema_version": "1.0", "values": []}
    with pytest.raises(ValidationError, match="extra_forbidden"):
        ExampleContract(unknown=True)


def test_contract_collection_defaults_are_not_shared() -> None:
    first = ExampleContract()
    second = ExampleContract()

    first.values.append("one")

    assert second.values == []


def test_enums_serialize_to_approved_wire_values() -> None:
    assert Database.GEO.value == "geo"
    assert Database.PUBMED.value == "pubmed"
    assert DataLevel.REPOSITORY_PROCESSED.value == "repository_processed"


@pytest.mark.parametrize("prefix", ["task", "attempt", "event"])
def test_prefixed_ids_use_lowercase_uuid4(prefix: str) -> None:
    generated = generate_prefixed_uuid(prefix)

    assert re.fullmatch(
        rf"{prefix}_[0-9a-f]{{8}}-[0-9a-f]{{4}}-4[0-9a-f]{{3}}-"
        r"[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        generated,
    )


@pytest.mark.parametrize("prefix", ["", "UPPER", "bad-prefix", "with space"])
def test_prefixed_ids_reject_unsafe_prefixes(prefix: str) -> None:
    with pytest.raises(ValueError, match="prefix"):
        generate_prefixed_uuid(prefix)


def test_dataset_id_canonicalizes_database_and_accession() -> None:
    assert make_dataset_id(Database.GEO, " GSE178352 ") == "ds_geo_gse178352"


def test_source_id_is_deterministic_for_canonical_source_tuple() -> None:
    first = make_source_id(
        Database.GEO,
        " GSE178352 ",
        " https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352 ",
    )
    second = make_source_id(
        Database.GEO,
        "gse178352",
        "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE178352",
    )

    assert first == second
    assert re.fullmatch(r"src_[0-9a-f]{32}", first)


def test_asset_id_preserves_the_full_verified_checksum() -> None:
    checksum = "ab" * 32

    assert asset_id_from_sha256(checksum.upper()) == f"asset_{checksum}"
    with pytest.raises(ValueError, match="SHA-256"):
        asset_id_from_sha256("not-a-checksum")


def test_record_id_is_deterministic_and_preserves_raw_tokens() -> None:
    first = make_record_id("ds_geo_gse178352", "ENSG000001.1", "GSM1")
    second = make_record_id("ds_geo_gse178352", "ENSG000001.1", "GSM1")
    changed = make_record_id("ds_geo_gse178352", "ENSG000001", "GSM1")

    assert first == second
    assert first != changed
    assert re.fullmatch(r"rec_[0-9a-f]{32}", first)
