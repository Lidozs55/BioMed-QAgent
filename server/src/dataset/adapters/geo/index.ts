/**
 * GEO dataset adapters (P5-04): expression matrices, sample metadata,
 * source relations and probe mapping.  Mirrors
 * ``backend/app/datasets/build/geo_adapter.py`` +
 * ``geo_sample_metadata.py`` + ``geo_relations.py`` + ``probe_mapping.py``
 * and the shared SOFT platform-table parser.
 */

export * from "./series-matrix.js";
export * from "./sample-metadata.js";
export * from "./relations.js";
export * from "./probe-mapping.js";
