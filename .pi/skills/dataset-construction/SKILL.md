---
name: dataset-construction
description: Construct a DatasetBuild through the trusted Dataset Core boundary.
---

# Dataset construction

Prepare a DatasetBuildSpec, validate it, correct any structured validation errors,
then execute it through the Dataset Core tool. Treat only the resulting Publication
as formal output. Never describe rejection, NO_DATA, cancellation, or failure as
success.
