"""Test 1: SkillRegistry registration — count, active/dormant, categories.

Verifies:
- register_all_skills() registers all 61 tools as skills
- 48 active, 13 dormant
- All 8 categories present
"""

from app.skills import get_skill_registry, register_all_skills


def test_registry_total_count():
    """All 61 tools from _TOOLS_METADATA should be registered as skills."""
    count = register_all_skills()
    assert count == 61, f"Expected 61 registered skills, got {count}"
    assert get_skill_registry().count() == 61


def test_active_vs_dormant_count():
    """48 active + 13 dormant = 61 total."""
    registry = get_skill_registry()
    all_skills = registry.list_skills()
    active = [s for s in all_skills if s.version == "active"]
    dormant = [s for s in all_skills if s.version == "dormant"]
    assert len(active) == 48, f"Expected 48 active, got {len(active)}"
    assert len(dormant) == 13, f"Expected 13 dormant, got {len(dormant)}"


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
        "datasources":  30,  # 17 active + 13 dormant
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
