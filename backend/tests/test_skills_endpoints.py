"""Test 6: FastAPI skill endpoints — list, detail, categories, count, search.

Uses FastAPI TestClient. Requires register_all_skills() before each test.

Verifies:
- GET /api/v1/skills returns list
- GET /api/v1/skills/{id} returns dict
- GET /api/v1/skills/categories returns list
- GET /api/v1/skills/count returns {"total": N, "category": null}
- POST /api/v1/skills/search returns results
- 404 for non-existent skill
"""

import pytest
from fastapi.testclient import TestClient

from app.skills import register_all_skills


@pytest.fixture
def client():
    """Create a TestClient with skills registered on app startup."""
    # Import the FastAPI app — register_all_skills is called in its lifespan
    from app.main import app
    # Ensure skills are registered before the test
    register_all_skills()
    return TestClient(app)


# ── GET /api/v1/skills ────────────────────────────────────────────


def test_list_skills(client):
    """GET /api/v1/skills returns list of 65 unique skills."""
    resp = client.get("/api/v1/skills")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 67, f"Expected 67 skills, got {len(data)}"
    # Verify each entry has required keys
    for entry in data:
        assert "skill_id" in entry
        assert "name" in entry
        assert "category" in entry


def test_list_skills_filter_by_category(client):
    """GET /api/v1/skills?category=datasources returns only datasources."""
    resp = client.get("/api/v1/skills?category=datasources")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 36, f"Expected 36 datasources, got {len(data)}"
    for entry in data:
        assert entry["category"] == "datasources"


def test_list_skills_filter_by_version(client):
    """GET /api/v1/skills?version=active returns only active skills."""
    resp = client.get("/api/v1/skills?version=active")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 46, f"Expected 46 active, got {len(data)}"
    for entry in data:
        assert entry["version"] == "active"

    resp2 = client.get("/api/v1/skills?version=dormant")
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert len(data2) == 21, f"Expected 21 dormant, got {len(data2)}"


# ── GET /api/v1/skills/{id} ──────────────────────────────────────


def test_get_skill_detail(client):
    """GET /api/v1/skills/pubmed returns a dict with full manifest."""
    resp = client.get("/api/v1/skills/pubmed")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, dict)
    assert data["skill_id"] == "pubmed"
    assert data["category"] == "datasources"
    assert "inputs" in data
    assert "outputs" in data
    assert "tags" in data


def test_get_skill_404(client):
    """GET /api/v1/skills/nonexistent returns 404."""
    resp = client.get("/api/v1/skills/nonexistent_skill_xyz")
    assert resp.status_code == 404
    detail = resp.json()["detail"]
    assert "Skill not found" in detail


# ── GET /api/v1/skills/categories ────────────────────────────────


def test_list_categories(client):
    """GET /api/v1/skills/categories returns 8 categories."""
    resp = client.get("/api/v1/skills/categories")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 8
    expected = {"analysis", "cleaners", "datasources", "export",
                "io", "optimization", "parsers", "viz"}
    assert set(data) == expected


# ── GET /api/v1/skills/count ─────────────────────────────────────


def test_count_skills(client):
    """GET /api/v1/skills/count returns total=65."""
    resp = client.get("/api/v1/skills/count")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 67
    assert data["category"] is None


def test_count_skills_by_category(client):
    """GET /api/v1/skills/count?category=analysis returns 7."""
    resp = client.get("/api/v1/skills/count?category=analysis")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 7
    assert data["category"] == "analysis"


# ── POST /api/v1/skills/search ───────────────────────────────────


def test_search_skills(client):
    """POST /api/v1/skills/search?query=... returns relevant results."""
    resp = client.post(
        "/api/v1/skills/search?query=protein%20interaction%20network&top_k=5"
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) <= 5
    # At least one result should relate to protein interaction
    skill_ids = [d["skill_id"] for d in data]
    assert "ppi_network" in skill_ids or "string" in skill_ids, (
        f"Neither ppi_network nor string found in top results: {skill_ids}"
    )


def test_search_skills_with_category_filter(client):
    """POST /api/v1/skills/search?category=analysis narrows results."""
    resp = client.post(
        "/api/v1/skills/search?query=gene&top_k=10&category=analysis"
    )
    assert resp.status_code == 200
    data = resp.json()
    for entry in data:
        assert entry["manifest"]["category"] == "analysis"


def test_search_skills_empty_query(client):
    """POST /api/v1/skills/search?query= returns empty or limited results."""
    resp = client.post("/api/v1/skills/search?query=")
    assert resp.status_code == 200
    data = resp.json()
    # Empty query after tokenization → all zero scores → empty list
    assert isinstance(data, list)
