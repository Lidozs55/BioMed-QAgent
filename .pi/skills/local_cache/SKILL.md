---
name: local_cache
description: Query the local cache for previously imported datasets before searching external databases.
---

# Local cache query

The local cache stores content-addressed dataset records committed by import
sessions from user-uploaded files. Each record carries its own column manifest
and topic/description/keywords metadata, recorded at commit time;
re-committing identical bytes deduplicates to the same dataset id.

## When to use

1. **Prefer first** — before calling external APIs such as `search_pubmed` or
   `search_geo`, check `search_local_cache` for matching cached data.
2. **Supplement** — when external APIs return nothing or are incomplete.
3. **Reuse prior imports** — data committed by earlier import sessions is
   searchable without re-downloading it.

## Tools

- `search_local_cache` — keyword search over dataset manifests.
- `describe_local_cache` — inspect one dataset by namespace and dataset id.
- `get_cache_dataset` — read data rows using the dataset's own recorded column
  schema.

## Namespaces

- user_import — records committed by import sessions from user uploads.

## Constraints

- Cache reads are research aids; a cache hit never replaces the trusted
  `execute_dataset_execution` publication path for formal artifacts.
