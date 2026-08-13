"""Skill categories — the four stable capability groups.

Kept as a standalone module after the Phase 2 removal of the Skill
catalog/registry/gateway runtime (docs/migration/phase2-skills-tools-migration.md).
The enum drives the databases projection and the legacy Agent prompt catalog.
"""

from __future__ import annotations

from enum import StrEnum


class SkillCategory(StrEnum):
    """Skill 四大类别。"""

    DISCOVERY = "discovery"
    ACQUISITION = "acquisition"
    PROCESSING = "processing"
    ANALYSIS = "analysis"
