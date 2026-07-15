"""Pipeline stage functions and output types."""
from app.pipeline.stages.base import (
    AcquisitionOutput,
    ArtifactBuildOutput,
    DiscoveryOutput,
    ProcessingOutput,
    StageContext,
    StageResult,
    ValidationOutput,
)
from app.pipeline.stages.acquisition import run_acquisition
from app.pipeline.stages.artifact_build import run_artifact_build
from app.pipeline.stages.discovery import run_discovery
from app.pipeline.stages.processing import run_processing
from app.pipeline.stages.validation import run_validation

__all__ = [
    "AcquisitionOutput",
    "ArtifactBuildOutput",
    "DiscoveryOutput",
    "ProcessingOutput",
    "StageContext",
    "StageResult",
    "ValidationOutput",
    "run_acquisition",
    "run_artifact_build",
    "run_discovery",
    "run_processing",
    "run_validation",
]
