"""Per-scope validation check modules.

Each module owns the checks for one artifact scope (main_data, reactome,
sample_metadata, source_assets, lineage). Check functions take a
``ValidationContext`` and return either a single check dict or a list of
check dicts, which the package orchestrator assembles in order.
"""
from __future__ import annotations
