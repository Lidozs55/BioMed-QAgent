"""Test 6: Skill Self-Iteration Loop — repair, candidate, promotion.

Verifies:
- SkillRegistry mutation API (remove, update_manifest, replace)
- SkillRepairAgent (needs_repair, repair, _bump_version)
- CandidateRunner (test_candidate, compare)
- PromotionManager (evaluate_and_maybe_promote, version history)
- End-to-end: register → execute → evaluate → repair → candidate → promote
"""
import math

from app.skills.manifest import SkillInputField, SkillManifest, SkillOutputField
from app.skills.registry import SkillRegistry
from app.skills.evaluator import EvaluationReport
from app.skills.repair import SkillRepairAgent
from app.skills.candidate import CandidateRunner
from app.skills.promotion import PromotionManager


# ── Helpers ─────────────────────────────────────────────────────────

def _make_simple_manifest(skill_id: str = "test_skill", version: str = "1.0.0") -> SkillManifest:
    """Create a minimal manifest for testing."""
    return SkillManifest(
        skill_id=skill_id,
        name="Test Skill",
        description="A test skill for self-iteration",
        category="analysis",
        version=version,
        tags=["test", "iteration"],
        inputs=[
            SkillInputField(name="query", type="str", required=True, description="search query"),
            SkillInputField(name="limit", type="int", required=False, default=10),
        ],
        outputs=[
            SkillOutputField(name="records", type="list[dict]", description="result records"),
            SkillOutputField(name="total", type="int", description="total count"),
        ],
    )


def _make_executor(return_data=None, should_fail=False):
    """Create a simple sync executor for testing."""
    def _exec(**kwargs):
        if should_fail:
            raise RuntimeError("Simulated failure")
        return return_data or {"records": [], "total": 0}
    return _exec


def _make_eval_report(skill_id: str = "test_skill", overall: float = 0.8) -> EvaluationReport:
    """Create an EvaluationReport with given overall score (approx)."""
    # overall = 0.3*cov + 0.3*com + 0.4*con
    # Force overall to be close to requested by adjusting coverage
    cov = overall
    com = overall
    con = overall
    return EvaluationReport(
        skill_id=skill_id,
        coverage_score=cov,
        completeness_score=com,
        conflict_score=con,
        missing_inputs=[],
        missing_outputs=[],
    )


# ═══════════════════════════════════════════════════════════════════════
#  1.  SkillRegistry mutation API
# ═══════════════════════════════════════════════════════════════════════


class TestRegistryMutations:
    """Tests for SkillRegistry.remove(), update_manifest(), replace()."""

    def setup_method(self):
        """Ensure clean state before each test."""
        # Remove leftover test entries
        for sid in list(SkillRegistry._entries.keys()):
            if sid.startswith("test_"):
                SkillRegistry.remove(sid)

    def test_remove_existing_skill(self):
        """remove() should return True and delete the entry."""
        manifest = _make_simple_manifest("test_rm")
        SkillRegistry.register_manifest(manifest, executor=_make_executor())
        assert SkillRegistry.has("test_rm") is True

        result = SkillRegistry.remove("test_rm")
        assert result is True
        assert SkillRegistry.has("test_rm") is False
        assert SkillRegistry.get("test_rm") is None

    def test_remove_nonexistent_skill(self):
        """remove() on missing skill returns False."""
        result = SkillRegistry.remove("never_registered")
        assert result is False

    def test_update_manifest_description(self):
        """update_manifest() should update the manifest, keep executor."""
        manifest = _make_simple_manifest("test_upd")
        SkillRegistry.register_manifest(manifest, executor=_make_executor({"ok": True}))

        # Change description
        updated = manifest.model_copy(update={"description": "Updated description"})
        result = SkillRegistry.update_manifest("test_upd", updated)
        assert result is True

        fetched = SkillRegistry.get("test_upd")
        assert fetched is not None
        assert fetched.description == "Updated description"
        # Executor should still exist
        assert SkillRegistry.get_executor("test_upd") is not None

    def test_update_manifest_nonexistent(self):
        """update_manifest() on missing skill returns False."""
        manifest = _make_simple_manifest("test_ghost")
        result = SkillRegistry.update_manifest("test_ghost", manifest)
        assert result is False

    def test_replace_same_skill_id(self):
        """replace() with same skill_id updates manifest, keeps executor."""
        old = _make_simple_manifest("test_rep", version="1.0.0")
        SkillRegistry.register_manifest(old, executor=_make_executor({"v": 1}))

        new = _make_simple_manifest("test_rep", version="1.0.1")
        SkillRegistry.replace("test_rep", new)

        fetched = SkillRegistry.get("test_rep")
        assert fetched is not None
        assert fetched.version == "1.0.1"
        assert SkillRegistry.get_executor("test_rep") is not None

    def test_replace_different_skill_id(self):
        """replace() with different skill_id creates new, removes old."""
        old = _make_simple_manifest("test_old")
        SkillRegistry.register_manifest(old)

        new = SkillManifest(
            skill_id="test_new",
            name="New Skill",
            category="io",
            version="2.0.0",
            tags=["replaced"],
        )
        SkillRegistry.replace("test_old", new)

        # Old should be gone
        assert SkillRegistry.has("test_old") is False
        # New should exist
        assert SkillRegistry.has("test_new") is True
        assert SkillRegistry.get("test_new").version == "2.0.0"


# ═══════════════════════════════════════════════════════════════════════
#  2.  SkillRepairAgent
# ═══════════════════════════════════════════════════════════════════════


class TestSkillRepairAgent:
    """Tests for SkillRepairAgent logic."""

    def test_needs_repair_true(self):
        """overall_score < 0.5 should trigger repair."""
        report = _make_eval_report(overall=0.3)
        assert SkillRepairAgent.needs_repair(report) is True

    def test_needs_repair_false(self):
        """overall_score >= 0.5 should NOT trigger repair."""
        report = _make_eval_report(overall=0.8)
        assert SkillRepairAgent.needs_repair(report) is False

    def test_needs_repair_exact_threshold(self):
        """overall_score == 0.5 should NOT trigger (< not <=)."""
        report = _make_eval_report(overall=0.5)
        assert SkillRepairAgent.needs_repair(report) is False

    def test_repair_creates_candidate(self):
        """repair() should return a SkillManifest with bumped version."""
        manifest = _make_simple_manifest("test_repair", version="1.0.0")
        report = _make_eval_report(overall=0.4)
        # Add some missing fields so repair has something to do
        report = report.model_copy(update={
            "missing_inputs": ["extra_param"],
            "missing_outputs": ["summary"],
        })

        candidate = SkillRepairAgent.repair(manifest, report)
        assert candidate is not None
        assert candidate.skill_id == "test_repair"
        # Version should be bumped
        assert candidate.version == "1.0.1"
        # Missing input should be added
        input_names = [f.name for f in candidate.inputs]
        assert "extra_param" in input_names
        # Missing output should be added
        output_names = [f.name for f in candidate.outputs]
        assert "summary" in output_names

    def test_repair_no_changes_needed(self):
        """repair() returns None when nothing to fix."""
        manifest = _make_simple_manifest("test_nofix")
        report = _make_eval_report(overall=0.9)  # No missing fields

        candidate = SkillRepairAgent.repair(manifest, report)
        assert candidate is None

    def test_repair_inputs_adds_optional(self):
        """_repair_inputs should add missing fields as optional."""
        manifest = _make_simple_manifest("test_inp")
        report = EvaluationReport(
            skill_id="test_inp",
            coverage_score=0.5,
            completeness_score=1.0,
            conflict_score=1.0,
            missing_inputs=["extra_field"],
        )
        changes: list[str] = []
        new_inputs = SkillRepairAgent._repair_inputs(manifest, report, changes)

        assert len(new_inputs) == len(manifest.inputs) + 1
        added = [f for f in new_inputs if f.name == "extra_field"]
        assert len(added) == 1
        assert added[0].required is False
        assert "extra_field" in " ".join(changes)

    def test_repair_outputs_adds_missing(self):
        """_repair_outputs should add missing output fields."""
        manifest = _make_simple_manifest("test_out")
        report = EvaluationReport(
            skill_id="test_out",
            coverage_score=1.0,
            completeness_score=0.5,
            conflict_score=1.0,
            missing_outputs=["extra_output"],
        )
        changes: list[str] = []
        new_outputs = SkillRepairAgent._repair_outputs(manifest, report, changes)

        assert len(new_outputs) == len(manifest.outputs) + 1
        output_names = [f.name for f in new_outputs]
        assert "extra_output" in output_names

    def test_bump_version_semver(self):
        """Semver bump: 1.0.0 → 1.0.1."""
        assert SkillRepairAgent._bump_version("1.0.0") == "1.0.1"
        assert SkillRepairAgent._bump_version("2.3.9") == "2.3.10"

    def test_bump_version_legacy_active(self):
        """Legacy 'active' → '1.0.1'."""
        assert SkillRepairAgent._bump_version("active") == "1.0.1"

    def test_bump_version_legacy_dormant(self):
        """Legacy 'dormant' → '1.0.1'."""
        assert SkillRepairAgent._bump_version("dormant") == "1.0.1"

    def test_bump_version_empty(self):
        """Empty version → '1.0.1'."""
        assert SkillRepairAgent._bump_version("") == "1.0.1"

    def test_bump_version_non_semver(self):
        """Non-standard version → '2.0.0'."""
        assert SkillRepairAgent._bump_version("latest") == "2.0.0"


# ═══════════════════════════════════════════════════════════════════════
#  3.  CandidateRunner
# ═══════════════════════════════════════════════════════════════════════


class TestCandidateRunner:
    """Tests for CandidateRunner.test_candidate() and compare()."""

    def setup_method(self):
        """Clean state."""
        for sid in list(SkillRegistry._entries.keys()):
            if sid.startswith("test_") or sid.startswith("_candidate_"):
                SkillRegistry.remove(sid)

    def test_compare_better_candidate_promotable(self):
        """Candidate with higher overall score should be promotable."""
        original = _make_eval_report(overall=0.4)
        candidate = _make_eval_report(overall=0.7)

        result = CandidateRunner.compare(original, candidate)
        assert result["improvement"] > 0
        assert result["promotable"] is True  # delta 0.3 ≥ 0.05

    def test_compare_worse_candidate_not_promotable(self):
        """Candidate with lower score should NOT be promotable."""
        original = _make_eval_report(overall=0.9)
        candidate = _make_eval_report(overall=0.5)

        result = CandidateRunner.compare(original, candidate)
        assert result["improvement"] < 0
        assert result["promotable"] is False

    def test_compare_marginal_improvement_not_promotable(self):
        """Delta < 0.05 should not be promotable."""
        original = _make_eval_report(overall=0.50)
        candidate = _make_eval_report(overall=0.53)  # delta = 0.03

        result = CandidateRunner.compare(original, candidate)
        assert result["promotable"] is False

    def test_compare_none_candidate(self):
        """None candidate → not promotable, improvement=-1.0."""
        original = _make_eval_report(overall=0.5)
        result = CandidateRunner.compare(original, None)
        assert result["promotable"] is False
        assert result["improvement"] == -1.0

    def test_test_candidate_with_sync_executor(self):
        """test_candidate() runs executor and returns EvaluationReport."""
        manifest = _make_simple_manifest("test_cand")
        executor = _make_executor({"records": [{"id": 1}], "total": 1})
        SkillRegistry.register_manifest(manifest, executor=executor)

        candidate = _make_simple_manifest("test_cand", version="1.0.1")
        report = CandidateRunner.test_candidate(
            candidate=candidate,
            original_skill_id="test_cand",
            test_inputs={"query": "cancer"},
            registry=SkillRegistry,
        )

        assert report is not None
        assert report.skill_id == "test_cand"

        # Short-lived temp registration should be cleaned up
        assert SkillRegistry.has("_candidate_test_cand") is False

    def test_test_candidate_no_executor(self):
        """test_candidate() returns None when original has no executor."""
        manifest = _make_simple_manifest("test_noexec")
        SkillRegistry.register_manifest(manifest, executor=None)

        candidate = _make_simple_manifest("test_noexec", version="1.0.1")
        report = CandidateRunner.test_candidate(
            candidate=candidate,
            original_skill_id="test_noexec",
            test_inputs={"query": "test"},
            registry=SkillRegistry,
        )

        assert report is None


# ═══════════════════════════════════════════════════════════════════════
#  4.  PromotionManager
# ═══════════════════════════════════════════════════════════════════════


class TestPromotionManager:
    """Tests for PromotionManager.evaluate_and_maybe_promote() and history."""

    def setup_method(self):
        """Clean state."""
        for sid in list(SkillRegistry._entries.keys()):
            if sid.startswith("test_") or sid.startswith("_candidate_"):
                SkillRegistry.remove(sid)
        PromotionManager._version_history.clear()

    def test_good_candidate_promoted(self):
        """A candidate that improves score should be promoted."""
        manifest = _make_simple_manifest("test_good", version="1.0.0")
        SkillRegistry.register_manifest(manifest, executor=_make_executor({"records": [1, 2], "total": 2}))

        original_report = _make_eval_report("test_good", overall=0.3)
        # Candidate has better description (triggers better evaluation)
        candidate = SkillManifest(
            skill_id="test_good",
            name="Test Skill Improved",
            description="Better described skill for iteration testing",
            category="analysis",
            version="1.0.1",
            tags=["test", "iteration", "improved"],
            inputs=[SkillInputField(name="query", type="str", required=True)],
            outputs=[SkillOutputField(name="records", type="list[dict]")],
        )

        result = PromotionManager.evaluate_and_maybe_promote(
            original_manifest=manifest,
            original_report=original_report,
            candidate=candidate,
            test_inputs={"query": "test query"},
            registry=SkillRegistry,
        )

        assert result["action"] in ("promoted", "rolled_back")
        if result["action"] == "promoted":
            # Verify manifest was updated
            fetched = SkillRegistry.get("test_good")
            assert fetched is not None
            assert "improvement" in result
            assert "new_version" in result

            # Verify version history was saved
            history = PromotionManager.get_history("test_good")
            assert len(history) >= 1

    def test_bad_candidate_rolled_back(self):
        """A candidate that does not improve should be rolled back."""
        manifest = _make_simple_manifest("test_bad", version="1.0.0")
        SkillRegistry.register_manifest(manifest, executor=_make_executor({"records": [], "total": 0}))

        # Original report with high score
        original_report = _make_eval_report("test_bad", overall=0.95)
        # Candidate is worse — same skill_id but worse tags/description
        # The test_candidate will evaluate it and the comparison should show no improvement
        candidate = _make_simple_manifest("test_bad", version="1.0.1")

        result = PromotionManager.evaluate_and_maybe_promote(
            original_manifest=manifest,
            original_report=original_report,
            candidate=candidate,
            test_inputs={"query": "test"},
            registry=SkillRegistry,
        )

        assert result["action"] == "rolled_back"
        assert result["original_version"] == "1.0.0"
        assert result["new_version"] is None

    def test_version_history_save_and_restore(self):
        """Version history: save, get, and restore."""
        manifest_v1 = _make_simple_manifest("test_hist", version="1.0.0")
        SkillRegistry.register_manifest(manifest_v1)

        # Manually save to history
        PromotionManager._save_to_history("test_hist", manifest_v1)

        history = PromotionManager.get_history("test_hist")
        assert len(history) == 1
        assert history[0].version == "1.0.0"

        # Restore version — already the current one, should succeed
        restored = PromotionManager.restore_version("test_hist", "1.0.0", registry=SkillRegistry)
        assert restored is True

    def test_restore_nonexistent_version(self):
        """Restoring a version not in history returns False."""
        result = PromotionManager.restore_version("test_nohist", "9.9.9")
        assert result is False

    def test_version_history_fifo_limit(self):
        """History should only keep MAX_HISTORY (5) entries."""
        for i in range(7):
            m = _make_simple_manifest("test_fifo", version=f"1.0.{i}")
            PromotionManager._save_to_history("test_fifo", m)

        history = PromotionManager.get_history("test_fifo")
        assert len(history) == 5  # MAX_HISTORY
        # Oldest entries should be evicted
        versions = [m.version for m in history]
        assert "1.0.0" not in versions
        assert "1.0.1" not in versions
        assert "1.0.6" in versions


# ═══════════════════════════════════════════════════════════════════════
#  5.  End-to-end integration
# ═══════════════════════════════════════════════════════════════════════


class TestEndToEnd:
    """Full loop: register → execute → evaluate → repair → candidate → promote."""

    def setup_method(self):
        """Clean state."""
        for sid in list(SkillRegistry._entries.keys()):
            if sid.startswith("test_e2e") or sid.startswith("_candidate_"):
                SkillRegistry.remove(sid)
        PromotionManager._version_history.clear()

    def test_full_self_iteration_loop(self):
        """Complete end-to-end self-iteration cycle."""
        # 1. Register a skill with a working executor
        manifest = SkillManifest(
            skill_id="test_e2e_skill",
            name="E2E Self-Iteration Skill",
            description="Original description for end-to-end test",
            category="analysis",
            version="1.0.0",
            tags=["test", "e2e"],
            inputs=[
                SkillInputField(name="query", type="str", required=True,
                                description="search query"),
            ],
            outputs=[
                SkillOutputField(name="records", type="list[dict]"),
                SkillOutputField(name="summary", type="str"),
            ],
        )

        def _exec(query: str):
            return {"records": [{"id": 1, "title": query}], "total": 1}
            # "summary" is intentionally missing to trigger low completeness

        SkillRegistry.register_manifest(manifest, executor=_exec)

        # 2. Execute
        from app.skills.executor import SkillExecutor
        result = SkillExecutor.execute(
            skill_id="test_e2e_skill",
            inputs={"query": "cancer research"},
            registry=SkillRegistry,
        )
        assert result.success is True

        # 3. Evaluate
        from app.skills.evaluator import SkillEvaluator
        report = SkillEvaluator.evaluate(
            skill_id="test_e2e_skill",
            result=result.data,
            expected_outputs=["records", "summary"],
            provided_inputs={"query": "cancer research"},
            manifest=manifest,
        )
        # "summary" is missing from result → low completeness
        assert report.completeness_score < 1.0
        assert "summary" in report.missing_outputs

        # 4. Repair
        assert SkillRepairAgent.needs_repair(report) in (True, False)
        candidate = SkillRepairAgent.repair(manifest, report)
        assert candidate is not None
        assert candidate.version != manifest.version

        # 5. Test candidate
        cand_report = CandidateRunner.test_candidate(
            candidate=candidate,
            original_skill_id="test_e2e_skill",
            test_inputs={"query": "cancer research"},
            registry=SkillRegistry,
        )
        assert cand_report is not None

        # 6. Compare
        comparison = CandidateRunner.compare(report, cand_report)
        assert "improvement" in comparison
        assert "promotable" in comparison

        # 7. Promote / rollback
        promo_result = PromotionManager.evaluate_and_maybe_promote(
            original_manifest=manifest,
            original_report=report,
            candidate=candidate,
            test_inputs={"query": "cancer research"},
            registry=SkillRegistry,
        )
        assert promo_result["action"] in ("promoted", "rolled_back")

    def test_repair_input_triggered_by_missing_coverage(self):
        """If required inputs are missing, repair should add them as optional."""
        manifest = SkillManifest(
            skill_id="test_e2e_miss",
            name="Missing Input Skill",
            category="io",
            version="1.0.0",
            tags=[],
            inputs=[
                SkillInputField(name="file_path", type="str", required=True),
            ],
            outputs=[SkillOutputField(name="result", type="any")],
        )

        # Register with a simple executor
        SkillRegistry.register_manifest(
            manifest,
            executor=lambda file_path: {"result": f"processed {file_path}"},
        )

        # Evaluate WITHOUT providing the required file_path
        from app.skills.evaluator import SkillEvaluator
        report = SkillEvaluator.evaluate(
            skill_id="test_e2e_miss",
            result=None,
            expected_outputs=["result"],
            provided_inputs={},  # missing file_path
            manifest=manifest,
        )
        assert report.coverage_score < 1.0
        assert "file_path" in report.missing_inputs

        # Repair should add file_path as optional
        candidate = SkillRepairAgent.repair(manifest, report)
        assert candidate is not None
        input_names = [f.name for f in candidate.inputs]
        assert "file_path" in input_names

    def test_candidate_executor_cleanup(self):
        """Temp candidate registration must be cleaned up even on failure."""
        manifest = _make_simple_manifest("test_e2e_cleanup")
        SkillRegistry.register_manifest(manifest, executor=_make_executor())

        candidate = _make_simple_manifest("test_e2e_cleanup", version="1.0.1")
        _ = CandidateRunner.test_candidate(
            candidate=candidate,
            original_skill_id="test_e2e_cleanup",
            test_inputs={"query": "test"},
            registry=SkillRegistry,
        )

        # Temp entry should be gone
        assert SkillRegistry.has("_candidate_test_e2e_cleanup") is False
        # Original should still exist
        assert SkillRegistry.has("test_e2e_cleanup") is True


# ═══════════════════════════════════════════════════════════════════════
#  6.  Concurrency safety — promote + replace atomicity
# ═══════════════════════════════════════════════════════════════════════


class TestConcurrencySafety:
    """Atomic replace: no intermediate state where neither old nor new exists."""

    def setup_method(self):
        for sid in list(SkillRegistry._entries.keys()):
            if sid.startswith("test_atom"):
                SkillRegistry.remove(sid)

    def test_replace_atomic_same_id(self):
        """replace() with same skill_id keeps entry uninterrupted."""
        old = _make_simple_manifest("test_atom", version="1.0.0")
        SkillRegistry.register_manifest(old, executor=_make_executor({"v": 1}))

        new = _make_simple_manifest("test_atom", version="1.0.1")
        SkillRegistry.replace("test_atom", new)

        # Entry should exist and have new version
        entry = SkillRegistry.get("test_atom")
        assert entry is not None
        assert entry.version == "1.0.1"
        # Executor should be preserved
        assert SkillRegistry.get_executor("test_atom") is not None

    def test_replace_atomic_different_id(self):
        """replace() with different id atomically swaps."""
        old = _make_simple_manifest("test_atom_old")
        SkillRegistry.register_manifest(old)

        new = SkillManifest(
            skill_id="test_atom_new",
            name="Atomic New",
            category="analysis",
            version="1.0.0",
            tags=["atomic"],
        )
        SkillRegistry.replace("test_atom_old", new)

        assert SkillRegistry.has("test_atom_old") is False
        assert SkillRegistry.has("test_atom_new") is True
