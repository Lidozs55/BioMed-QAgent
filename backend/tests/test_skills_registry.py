"""Test 1: SkillRegistry registration — count, active/dormant, categories.

Verifies:
- register_all_skills() registers all 67 entries (65 unique after dedup)
- 46 active, 19 dormant
- All 8 categories present
"""

from app.skills import get_skill_registry, register_all_skills


def test_registry_total_count():
    """All 63 tools from _TOOLS_METADATA should be registered as skills."""
    count = register_all_skills()
    assert count == 67, f"Expected 67 entries processed, got {count}"
    assert get_skill_registry().count() == 65


def test_active_vs_dormant_count():
    """46 active + 19 dormant = 65 unique."""
    registry = get_skill_registry()
    all_skills = registry.list_skills()
    active = [s for s in all_skills if s.version == "active"]
    dormant = [s for s in all_skills if s.version == "dormant"]
    assert len(active) == 46, f"Expected 46 active, got {len(active)}"
    assert len(dormant) == 19, f"Expected 19 dormant, got {len(dormant)}"


def test_all_eight_categories_present():
    """All 8 categories must appear in registered skills."""
    registry = get_skill_registry()
    categories = registry.list_categories()
    expected = {"analysis", "cleaners", "datasources", "export",
                "io", "optimization", "parsers", "viz"}
    assert set(categories) == expected, f"Missing categories: {expected - set(categories)}"


def test_category_counts():
    """Verify per-category counts match _TOOLS_METADATA."""
    registry = get_skill_registry()
    expected = {
        "datasources":  34,  # 15 active + 19 dormant (drugbank/disgenet moved to dormant)
        "parsers":       6,
        "cleaners":      3,
        "analysis":      7,
        "io":            4,
        "optimization":  3,
        "viz":           5,
        "export":        3,
    }
    for cat, count in expected.items():
        skills = registry.list_skills(category=cat)
        assert len(skills) == count, (
            f"Category {cat!r}: expected {count} skills, got {len(skills)}"
        )


def test_get_known_skill():
    """get() and has() return correct results for known skill IDs."""
    registry = get_skill_registry()
    assert registry.has("pubmed") is True
    assert registry.has("ppi_network") is True
    assert registry.has("nonexistent_skill") is False

    pubmed = registry.get("pubmed")
    assert pubmed is not None
    assert pubmed.skill_id == "pubmed"
    assert pubmed.category == "datasources"
