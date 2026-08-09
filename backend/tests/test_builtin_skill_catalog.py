from __future__ import annotations

from app.skills.builtin import load_builtin_skill_descriptors


def test_builtin_skill_catalog_has_one_complete_truthful_projection() -> None:
    descriptors = load_builtin_skill_descriptors()
    by_name = {descriptor.name: descriptor for descriptor in descriptors}

    assert len(descriptors) == 17
    assert len(by_name) == len(descriptors)
    assert {name for name, item in by_name.items() if item.pipeline_supported} == {
        "pubmed",
        "geo",
        "gdc",
        "xena",
        "reactome",
    }
    assert {name for name, item in by_name.items() if item.user_selectable} == {
        "pubmed",
        "geo",
        "gdc",
        "pdb",
        "xena",
        "pubchem",
        "reactome",
        "uniprot",
        "chembl",
    }
    assert "create_skill" in by_name
    assert {operation.access_requirement for operation in by_name["create_skill"].operations} == {
        "public"
    }
    assert "self_evolution" not in by_name
