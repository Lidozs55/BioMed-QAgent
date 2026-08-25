import { describe, expect, it } from "vitest";
import { createDefaultRegisteredTableRegistry } from "../src/dataset/adapters/registered/index.js";
import {
  BrowserParserRecipeRegistry,
  browserRecipeId,
  createDefaultBrowserParserRecipeRegistry,
} from "../src/dataset/acquisition/browser-recipe-registry.js";

const evidence = {
  schema_version: "1.0" as const,
  evidence_id: "browser_evidence_fixture",
  task_id: "task_fixture",
  run_id: "run_fixture",
  requested_url: "https://example.org/table.json",
  final_url: "https://example.org/table.json",
  redirect_chain: [],
  status: 200,
  media_type: "application/json",
  retrieved_at: "2026-08-25T00:00:00.000Z",
  bytes_received: 2,
  sha256: "a".repeat(64),
  browser_policy_revision: "public-http-browser.v1" as const,
  source_asset_id: "asset_fixture",
  source_id: "source_fixture",
  relative_path: "source_assets/table.json",
  download_attempt_id: "download_fixture",
  provider_id: "browser.snapshot.v1" as const,
  provider_implementation_digest: "b".repeat(64),
};

describe("default browser parser recipe catalog", () => {
  it("promotes every Core-owned registered parser with a deterministic identity", () => {
    const tables = createDefaultRegisteredTableRegistry();
    const recipes = createDefaultBrowserParserRecipeRegistry(tables);

    expect(recipes.list()).toHaveLength(tables.list().length);
    const registration = tables.entries().find((entry) => entry.parser.format === "json");
    expect(registration).toBeDefined();
    const recipeId = browserRecipeId(registration!.parser.adapter_id, registration!.parser.parser_version);
    const resolved = recipes.resolve(recipeId, "1", {
      ...evidence,
      media_type: registration!.parser.media_types[0]!,
    });

    expect(resolved).toMatchObject({
      ref: { recipe_id: recipeId, recipe_version: 1, status: "PROMOTED" },
      schema_ref: registration!.schema.schema_id,
      adapter_id: registration!.parser.adapter_id,
      parser_version: registration!.parser.parser_version,
    });
    expect(resolved.ref.implementation_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(recipes.resolveRegisteredTable(resolved.adapter_id, resolved.parser_version))
      .toEqual(registration);
  });

  it("does not promote a catch-all browser.json.v1 alias", () => {
    const recipes = createDefaultBrowserParserRecipeRegistry();
    expect(recipes.list()).not.toContain("browser.json.v1@1");
    expect(() => recipes.resolve("browser.json.v1", "1", evidence))
      .toThrow("unknown browser parser recipe");
  });

  it("rejects a recipe whose registered parser media types do not match", () => {
    const tables = createDefaultRegisteredTableRegistry();
    const registry = new BrowserParserRecipeRegistry(tables);
    const registration = tables.entries()[0]!;
    expect(() => registry.register({
      ref: {
        schema_version: "1.0",
        recipe_id: "browser.fixture.invalid-media",
        recipe_version: 1,
        status: "PROMOTED",
        implementation_digest: "c".repeat(64),
      },
      schema_ref: registration.schema.schema_id,
      adapter_id: registration.parser.adapter_id,
      parser_version: registration.parser.parser_version,
      media_types: ["application/x-unregistered"],
    })).toThrow("media type is not accepted");
  });
});
