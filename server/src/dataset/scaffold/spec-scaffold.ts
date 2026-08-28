/**
 * Deterministic DatasetExecutionSpec scaffolding for registered multi-table
 * families (P1 formal-route scaffold, static route). The server composes the
 * full frozen spec — every enum field, default profile/merge/output value,
 * and entities placement — from the live family registry, so the Agent only
 * supplies the family id, phenotype/study entities, and one
 * ``{source, adapter_id, accession}`` tuple per binding. The output is
 * validate/execute-ready; the Agent must pass it through
 * ``validate_dataset_execution`` unchanged.
 */

import type { DatasetExecutionSpec } from "../contracts/index.js";
import type { SourceBinding } from "../contracts/spec.js";
import type { DatasetFamilyRegistry } from "../families/index.js";

export interface ScaffoldBindingInput {
  source: string;
  adapter_id: string;
  accession: string | null;
}

export interface DatasetSpecScaffoldInput {
  family_id: string;
  requirement_id: string;
  objective?: string;
  /** Entity map; values may be scalars or string arrays, normalized to one non-empty string each. */
  entities: Record<string, string | string[]>;
  bindings: readonly ScaffoldBindingInput[];
}

export interface DatasetSpecScaffold {
  spec: DatasetExecutionSpec;
  notes: string[];
}

function normalizeEntities(
  entities: Record<string, string | string[]>,
  notes: string[],
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(entities)) {
    const values = Array.isArray(value) ? value : [value];
    const strings = values.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    if (strings.length === 0) {
      notes.push(`entities.${key} was empty and is dropped; supply one non-empty string`);
      continue;
    }
    if (strings.length > 1) {
      notes.push(`entities.${key} had multiple values; scaffold keeps only the first`);
    }
    normalized[key] = [strings[0]!.trim()];
  }
  return normalized;
}

/**
 * Compose a valid spec for a registered-multitable family. Throws a
 * descriptive TypeError for unknown families, unknown source/adapter pairs,
 * or provider bindings with empty accessions; every other decision is taken
 * from the family definition itself.
 */
export function buildDatasetExecutionScaffold(
  registry: DatasetFamilyRegistry,
  input: DatasetSpecScaffoldInput,
): DatasetSpecScaffold {
  const notes: string[] = [];
  const registered = registry.list();
  if (!registered.includes(input.family_id)) {
    throw new TypeError(
      `unknown dataset family ${JSON.stringify(input.family_id)}; registered: ` +
        registered.join(", "),
    );
  }
  const definition = registry.get(input.family_id);
  if (definition.runtime_id !== "registered_multitable.runtime.v1") {
    throw new TypeError(
      `scaffold supports registered-multitable families only; ${definition.id} uses ${definition.runtime_id}`,
    );
  }
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) {
    throw new TypeError("bindings must list at least one {source, adapter_id, accession} entry");
  }
  const sourceBindings: SourceBinding[] = input.bindings.map((binding, index) => {
    const sourceDefinition = definition.sources.find(
      (source) => source.source === binding.source && source.adapter_id === binding.adapter_id,
    );
    if (sourceDefinition === undefined) {
      const known = definition.sources
        .filter((source) => source.source === binding.source)
        .map((source) => source.adapter_id);
      throw new TypeError(
        `bindings[${index}] pair ${JSON.stringify(binding.source)}/${JSON.stringify(binding.adapter_id)} ` +
          `is not registered for family ${definition.id}` +
          (known.length > 0 ? `; known adapters for this source: ${known.join(", ")}` : ""),
      );
    }
    const accession = typeof binding.accession === "string" ? binding.accession.trim() : "";
    if (accession === "") {
      notes.push(
        `bindings[${index}] (${binding.source}/${binding.adapter_id}) has an empty accession; ` +
          "the validator will reject it unless a registered carrier asset is supplied via source_files",
      );
    }
    return {
      schema_version: "1.0",
      binding_id: `binding_${index + 1}_${binding.source}`,
      source: binding.source,
      acquisition: {
        schema_version: "1.0",
        mode: "builtin",
        provider_id: null,
        recipe_id: null,
        recipe_version: null,
      },
      adapter_id: binding.adapter_id,
      accession: accession === "" ? null : accession,
      parameters: {},
    };
  });
  const schemaRef = definition.schemas[0]!.schema_id;
  return {
    spec: {
      schema_version: "1.0",
      requirement_id: input.requirement_id,
      objective: input.objective ?? `Registered-family build scaffold for ${definition.id}`,
      dataset_family: definition.id,
      row_granularity: definition.granularities[0]!.id,
      entities: normalizeEntities(input.entities, notes),
      cohort_filters: {},
      required_fields: [],
      schema_ref: schemaRef,
      source_bindings: sourceBindings,
      normalization_profile_ref: definition.default_normalization_profile_ref,
      merge_strategy: definition.merge_strategies[0]!,
      validation_profile_ref: definition.validation_profile_refs[0]!,
      output_format: definition.output_formats[0]!,
      target_entity_level: null,
    },
    notes,
  };
}
