"""Test 4: SkillManifest validation — all manifests have complete fields.

Verifies every registered SkillManifest has:
- Non-empty skill_id, name, description, category
- Non-empty tags list
- inputs list and outputs list present
- Spot-check category mappings
"""

from app.skills import register_all_skills, get_skill_registry


def test_all_manifests_have_required_fields():
    """Every skill manifest must have non-empty identifiers."""
    register_all_skills()
    registry = get_skill_registry()
    skills = registry.list_skills()

    assert len(skills) == 67, f"Expected 67 unique skills (69 processed, 2 deduped), got {len(skills)}"

    for s in skills:
        assert s.skill_id, f"skill_id is empty for {s}"
        assert s.name, f"name is empty for {s.skill_id}"
        assert s.description, f"description is empty for {s.skill_id}"
        assert s.category, f"category is empty for {s.skill_id}"
        assert isinstance(s.tags, list), f"tags is not a list for {s.skill_id}"
        assert len(s.tags) > 0, f"tags is empty for {s.skill_id}"
        assert isinstance(s.inputs, list), f"inputs is not a list for {s.skill_id}"
        assert isinstance(s.outputs, list), f"outputs is not a list for {s.skill_id}"


def test_known_skills_have_correct_category():
    """Spot-check a few skills have expected category mapping."""
    register_all_skills()
    registry = get_skill_registry()

    checks = [
        ("pubmed", "datasources"),
        ("string", "datasources"),
        ("pdf_table", "parsers"),
        ("field_aligner", "cleaners"),
        ("ppi_network", "analysis"),
        ("csv_to_json", "io"),
        ("keyword_expander", "optimization"),
        ("volcano_plot", "viz"),
        ("to_csv", "export"),
    ]
    for skill_id, expected_cat in checks:
        m = registry.get(skill_id)
        assert m is not None, f"Skill {skill_id!r} not found"
        assert m.category == expected_cat, (
            f"{skill_id!r}: expected category {expected_cat!r}, got {m.category!r}"
        )


def test_dormant_skills_have_correct_version():
    """Dormant skills must have version='dormant'."""
    register_all_skills()
    registry = get_skill_registry()
    dormant_ids = {
        "biogrid", "cbioportal", "chembl", "cnki", "depmap", "disgenet", "drugbank",
        "enrichr", "ensembl", "genecards", "gprofiler", "hgnc",
        "lincs", "omim", "openfda", "opentargets", "pdc",
        "reactome", "ucsc_xena", "uniprot", "wanfang",
    }
    for sid in dormant_ids:
        m = registry.get(sid)
        assert m is not None, f"Dormant skill {sid!r} not registered"
        assert m.version == "dormant", (
            f"{sid!r}: expected version 'dormant', got {m.version!r}"
        )


def test_active_skills_have_version_active():
    """All non-dormant skills should have version='active'."""
    register_all_skills()
    registry = get_skill_registry()
    dormant_ids = {
        "biogrid", "cbioportal", "chembl", "cnki", "depmap", "disgenet", "drugbank",
        "enrichr", "ensembl", "genecards", "gprofiler", "hgnc",
        "lincs", "omim", "openfda", "opentargets", "pdc",
        "reactome", "ucsc_xena", "uniprot", "wanfang",
    }
    for s in registry.list_skills():
        if s.skill_id not in dormant_ids:
            assert s.version == "active", (
                f"{s.skill_id!r}: expected 'active', got {s.version!r}"
            )


def test_display_names_are_title_case():
    """Skill display names should be Title Case from skill_id."""
    register_all_skills()
    registry = get_skill_registry()

    name_checks = [
        ("pubmed", "Pubmed"),
        ("ppi_network", "Ppi Network"),
        ("field_aligner", "Field Aligner"),
        ("csv_to_json", "Csv To Json"),
    ]
    for skill_id, expected_name in name_checks:
        m = registry.get(skill_id)
        assert m is not None
        assert m.name == expected_name, (
            f"{skill_id!r}: expected name {expected_name!r}, got {m.name!r}"
        )
