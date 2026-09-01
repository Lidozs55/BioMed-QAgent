---
name: local_cache
description: Query the local cache for previously imported or cached datasets before searching external databases.
---

# Local cache query

The local cache stores cleaned, schema-neutral long-format datasets (each
cached dataset carries its own column manifest, recorded at import/caching
time) from user imports and prior research-task artifacts.

## When to use

1. **Prefer first** — before calling external APIs such as `search_pubmed` or
   `search_geo`, check `search_local_cache` for matching cached data.
2. **Supplement** — when external APIs return nothing or are incomplete.
3. **Reuse cleaning results** — prior tasks' cleaned data is cached; avoid
   re-cleaning.

## Tools

- `search_local_cache` — keyword search over dataset manifests.
- `describe_local_cache` — inspect one dataset by namespace and dataset id.
- `get_cache_dataset` — read data rows using the dataset's own recorded column
  schema.

## Namespaces

- user_import — data imported through file upload.
- pipeline_artifact — artifacts auto-cached from prior research tasks
  (not yet implemented).

## Constraints

- Cache reads are research aids; a cache hit never replaces the trusted
  `execute_dataset_execution` publication path for formal artifacts.
