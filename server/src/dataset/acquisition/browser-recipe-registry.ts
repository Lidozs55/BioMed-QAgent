import type { WorkflowRecipeRef } from "@biomed/contracts";
import type { BrowserAcquisitionEvidence } from "@biomed/contracts";
import type { RegisteredTableRegistry } from "../adapters/registered/registry.js";

export interface BrowserParserRecipeRegistration {
  ref: WorkflowRecipeRef;
  schema_ref: string;
  adapter_id: string;
  parser_version: string;
  media_types: readonly string[];
}

export class BrowserParserRecipeRegistry {
  readonly #registeredTables: RegisteredTableRegistry;
  readonly #recipes = new Map<string, BrowserParserRecipeRegistration>();

  constructor(registeredTables: RegisteredTableRegistry) {
    this.#registeredTables = registeredTables;
  }

  register(registration: BrowserParserRecipeRegistration): void {
    const { ref } = registration;
    if (ref.status !== "PROMOTED") throw new Error(`browser parser recipe must be PROMOTED: ${ref.recipe_id}`);
    if (registration.media_types.length === 0) throw new Error("browser parser recipe must declare media types");
    const parser = this.#registeredTables.resolve(registration.adapter_id, registration.parser_version).parser;
    if (parser.schema_ref !== registration.schema_ref) {
      throw new Error(`browser recipe schema does not match registered parser: ${registration.ref.recipe_id}`);
    }
    for (const mediaType of registration.media_types) {
      if (!parser.media_types.includes(mediaType.toLowerCase())) {
        throw new Error(`browser recipe media type is not accepted by registered parser: ${mediaType}`);
      }
    }
    const key = `${ref.recipe_id}@${ref.recipe_version}`;
    if (this.#recipes.has(key)) throw new Error(`browser parser recipe already exists: ${key}`);
    this.#recipes.set(key, {
      ref: { ...ref },
      schema_ref: registration.schema_ref,
      adapter_id: registration.adapter_id,
      parser_version: registration.parser_version,
      media_types: [...registration.media_types],
    });
  }

  resolve(recipeId: string, recipeVersion: string, evidence: BrowserAcquisitionEvidence): BrowserParserRecipeRegistration {
    const entry = this.#recipes.get(`${recipeId}@${recipeVersion}`);
    if (entry === undefined) throw new Error(`unknown browser parser recipe: ${recipeId}@${recipeVersion}`);
    if (entry.ref.status !== "PROMOTED") throw new Error(`browser parser recipe is not PROMOTED: ${recipeId}@${recipeVersion}`);
    if (!entry.media_types.includes(evidence.media_type.toLowerCase())) {
      throw new Error(`browser parser recipe does not accept media type: ${evidence.media_type}`);
    }
    const parser = this.#registeredTables.resolve(entry.adapter_id, entry.parser_version).parser;
    if (parser.schema_ref !== entry.schema_ref) {
      throw new Error(`browser recipe schema drift: ${entry.ref.recipe_id}@${entry.ref.recipe_version}`);
    }
    return {
      ref: { ...entry.ref },
      schema_ref: entry.schema_ref,
      adapter_id: entry.adapter_id,
      parser_version: entry.parser_version,
      media_types: [...entry.media_types],
    };
  }

  list(): string[] {
    return [...this.#recipes.keys()].sort();
  }
}
