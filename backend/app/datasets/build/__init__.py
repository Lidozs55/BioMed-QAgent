"""V2 dataset build chain components (Phase 3).

Pure, deterministic stages that implement the expression demo chain:

    parse[*] -> canonicalize[*] -> compatibility gate -> integrate
    -> validate profile -> manifest

The legacy pipeline runner is not required; the durable runtime (Phase 2)
will orchestrate these components behind the fixed build skeleton.
"""

from __future__ import annotations

from app.datasets.build.adapters import (
    GdcExpressionAdapter,
    SourceAdapter,
    XenaMatrixAdapter,
    get_adapter,
)
from app.datasets.build.canonicalizer import CanonicalizationResult, canonicalize
from app.datasets.build.chain import BuildChainResult, build_expression_dataset
from app.datasets.build.compat_gate import (
    CompatibilityReport,
    check_expression_compatibility,
)
from app.datasets.build.errors import AdapterError, BuildError, IntegratorError
from app.datasets.build.integrator import IntegrationResult, integrate
from app.datasets.build.manifest import (
    assemble_manifest,
    build_manifest,
    build_provenance_document,
    write_manifest,
)
from app.datasets.build.profiles import (
    ExpressionValidationProfile,
    get_normalization_profile,
    get_validation_profile,
)

__all__ = [
    "AdapterError",
    "BuildChainResult",
    "BuildError",
    "CanonicalizationResult",
    "CompatibilityReport",
    "ExpressionValidationProfile",
    "GdcExpressionAdapter",
    "IntegrationResult",
    "IntegratorError",
    "SourceAdapter",
    "XenaMatrixAdapter",
    "assemble_manifest",
    "build_expression_dataset",
    "build_manifest",
    "build_provenance_document",
    "canonicalize",
    "check_expression_compatibility",
    "get_adapter",
    "get_normalization_profile",
    "get_validation_profile",
    "integrate",
    "write_manifest",
]
