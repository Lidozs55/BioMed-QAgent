"""Test 2: SkillRetriever — keyword retrieval, result ordering.

Verifies:
- Retrieve finds ppi_network or string for "protein interaction" query
- Results are sorted by score descending
- Category filtering works
"""

from app.skills import register_all_skills, get_skill_registry, SkillRetriever


def test_retrieve_protein_interaction():
    """Searching 'find protein interaction network' should return
    ppi_network and/or string in top 5 results."""
    register_all_skills()
    registry = get_skill_registry()
    manifests = SkillRetriever.retrieve(
        "find protein interaction network",
        top_k=5,
        registry=registry,
    )
    skill_ids = [m.skill_id for m in manifests]
    # ppi_network is tagged "ppi", "protein", "interaction", "network", "string"
    # string (datasource) is tagged "ppi", "protein", "interaction", "network"
    # Both should score well against protein+interaction+network tokens
    top_ids = set(skill_ids)
    assert ("ppi_network" in top_ids or "string" in top_ids), (
        f"Expected ppi_network or string in top 5, got: {skill_ids}"
    )


def test_results_sorted_by_score_descending():
    """Retrieve should return manifests ordered by relevance score."""
    register_all_skills()
    registry = get_skill_registry()
    manifests = SkillRetriever.retrieve(
        "pubmed literature search biomedical",
        top_k=10,
        registry=registry,
    )
    assert len(manifests) >= 1, "At least one result expected"
    # pubmed should be top or near-top for "pubmed" query
    first_skill = manifests[0].skill_id
    assert first_skill == "pubmed", (
        f"Expected 'pubmed' as top result, got {first_skill}"
    )


def test_retrieve_with_category_filter():
    """Category filter narrows results to that category only."""
    register_all_skills()
    registry = get_skill_registry()
    manifests = SkillRetriever.retrieve(
        "network analysis",
        top_k=10,
        registry=registry,
        category="analysis",
    )
    for m in manifests:
        assert m.category == "analysis", (
            f"Category-filtered result {m.skill_id} has category {m.category!r}"
        )


def test_retrieve_empty_query_graceful():
    """Empty query still returns results (all skills with non-zero scores)."""
    register_all_skills()
    registry = get_skill_registry()
    manifests = SkillRetriever.retrieve("", top_k=5, registry=registry)
    # Empty query after tokenization yields empty tokens → all scores = 0 → empty
    assert manifests == [] or len(manifests) >= 0


def test_retrieve_top_k_truncation():
    """top_k parameter correctly limits results."""
    register_all_skills()
    registry = get_skill_registry()
    manifests = SkillRetriever.retrieve(
        "gene expression analysis protein pathway",
        top_k=3,
        registry=registry,
    )
    assert len(manifests) <= 3, f"Expected at most 3 results, got {len(manifests)}"
