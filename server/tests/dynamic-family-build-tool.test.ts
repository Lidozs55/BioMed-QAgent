import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_RUNTIME_LIMITS, computeFamilySpecDigest, type FamilySpec, type Projection } from "@biomed/contracts";
import { describe, expect, test } from "vitest";

import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import {
  createDynamicFamilyBuildTool,
  parseDynamicFamilyBuildSubmission,
} from "../src/agent/tools/dynamic-family-build.js";
import { submitDynamicFamilyBuild } from "../src/dataset/dynamic-family/submission.js";
import { expectedOutputLocatorClosure } from "../src/dataset/dynamic-family/execution.js";
import { publishDynamicFamily } from "../src/dataset/dynamic-family/publication.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

async function submission(): Promise<Record<string, unknown>> {
  const projection: Projection = {
    projection_id: "projection_dynamic",
    schema_version: "2.0",
    primary_tables: ["records"],
    supporting_tables: [],
    derived_tables: [],
    required: ["records"],
    optional: [],
    allow_empty: [],
    relations: [],
    row_granularity: "record",
    compatibility_dimensions: [],
    merge_identity_fields: ["record_id"],
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
  };
  const unsigned: FamilySpec = {
    family_spec_id: "family_dynamic",
    semantic_version: "1.0.0",
    canonical_digest: A,
    projections: [projection],
    table_definitions: [{
      table_id: "records", schema_ref: "schema_records", role: "primary",
      required: true, allow_empty: false, primary_key: ["record_id"],
      field_names: ["record_id", "value"],
    }],
    relations: [],
    identity: {
      dataset_id_scheme: "ds_hash", dataset_revision_id_scheme: "dsrev_hash",
      asset_id_scheme: "asset_sha256", sample_identity_fields: ["dataset_revision_id", "sample_id"],
      probe_mapping_assertion_pk: "mapping_assertion_id",
    },
    transform_capability_refs: [],
    declared_outputs: [{ table_id: "records", schema_ref: "schema_records" }],
    integration_policy_ref: "policy_integration",
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
    resource_class_request: "small",
    scope: "task",
    author: "agent",
    evidence_refs: [],
  };
  const family = { ...unsigned, canonical_digest: await computeFamilySpecDigest(unsigned) };
  return {
    schema_version: "1.0",
    execution_backend: "in_process_unisolated",
    family_spec: family,
    projection_id: projection.projection_id,
    transform_source: "export const transform = { run() { return { outputs: [] }; } };",
    transform_metadata: {
      transform_id: "transform_dynamic", version: "1.0.0", entrypoint: "transform.run",
      declared_input_roles: [{ role: "source", media_type: "text/csv", constraint_ref: null }],
      declared_output_tables: [{ table_id: "records", schema_ref: "schema_records" }],
      bound_family_spec_digest: family.canonical_digest,
      bound_projection_digest: canonicalDigest(projection),
      determinism_profile: "deterministic", resource_class: "small", origin: "agent",
      scope: "task", review_refs: [],
    },
    registered_sources: { source_binding: `asset_${A}` },
    acquisition_requests: {},
    build_proposal: {
      schema_version: "2.0", spec_kind: "proposal", build_id: "build_dynamic",
      family_spec_ref: { scope: "task", id: family.family_spec_id, version: family.semantic_version, digest: family.canonical_digest },
      projection_ref: projection.projection_id,
      transform_refs: [{ scope: "task", id: "transform_dynamic", version: "1.0.0", digest: B }],
      policy_refs: [], output_format: "long_table", idempotency_identity: "dynamic_identity",
      source_bindings: [{
        binding_id: "source_binding", source: "registered_asset",
        input_requirement_ref: "source", parameters: {},
      }],
    },
  };
}

describe("dynamic family build tool boundary", () => {
  test("requires committed outputs only for locators used by declared outputs", () => {
    const output = (tableId: string, locatorRef: string) => ({
      table_id: tableId,
      schema_ref: `schema_${tableId}`,
      artifact_ref: `artifact_${tableId}`,
      locator_ref: locatorRef,
      relative_path: `tables/${tableId}.csv`,
      delimiter: "," as const,
      header: ["id"],
      source_locators: [],
    });
    expect(expectedOutputLocatorClosure([
      output("primary", "asset_source_a"),
      output("supporting", "asset_source_a"),
      output("derived", "asset_source_b"),
    ])).toEqual(["asset_source_a", "asset_source_b"]);
  });

  test("parses only an explicitly unisolated, digest-bound submission", async () => {
    const parsed = await parseDynamicFamilyBuildSubmission(await submission());
    expect(parsed.execution_backend).toBe("in_process_unisolated");
    expect(parsed.family_spec.scope).toBe("task");
    expect(parsed.projection.projection_id).toBe("projection_dynamic");
  });

  test("accepts a fixed Core provider request instead of a pre-registered carrier", async () => {
    const raw = await submission();
    raw.registered_sources = {};
    raw.acquisition_requests = {
      source_binding: {
        provider_id: "chembl.files.v1",
        parameters: {
          source: "chembl",
          accession: "CHEMBL203",
          entities: { target_ids: ["CHEMBL203"], compound_ids: ["CHEMBL25"] },
        },
      },
    };
    const parsed = await parseDynamicFamilyBuildSubmission(raw);
    expect(parsed.acquisition_requests.source_binding?.provider_id).toBe("chembl.files.v1");
    expect(parsed.registered_sources).toEqual({});
  });

  test("accepts a PubMed full-text Core acquisition request", async () => {
    const raw = await submission();
    raw.registered_sources = {};
    raw.acquisition_requests = {
      source_binding: {
        provider_id: "pubmed.files.v1",
        parameters: {
          source: "pubmed",
          accession: "PMC10408569",
          entities: {},
        },
      },
    };
    const parsed = await parseDynamicFamilyBuildSubmission(raw);
    expect(parsed.acquisition_requests.source_binding?.provider_id).toBe("pubmed.files.v1");
    expect(parsed.registered_sources).toEqual({});
  });

  test("exposes the complete nested contract and fixed-provider parameter guidance", () => {
    const tool = createDynamicFamilyBuildTool({ submit: async () => ({ ok: true }) });
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain('"table_definitions"');
    expect(schema).toContain('"field_names"');
    expect(schema).toContain("Synchronous TypeScript only");
    expect(schema).toContain("target_records");
    expect(schema).toContain("maxItems");
    expect(schema).toContain("chembl.files.v1");
    expect(schema).toContain("pubchem.files.v1");
    expect(schema).toContain("pubmed.files.v1");
    expect(schema).toContain("One PMCID per binding");
    expect(schema).toContain("^PMC[1-9][0-9]*$");
    expect(schema).toContain("geo.files.v1");
  });

  test("returns computable family and projection binding digests", async () => {
    const raw = await submission();
    const family = raw.family_spec as FamilySpec;
    raw.family_spec = { ...family, canonical_digest: "0".repeat(64) };
    await expect(parseDynamicFamilyBuildSubmission(raw)).rejects.toThrow(/canonical_digest must equal [0-9a-f]{64}/);
  });

  test("exposes one callback-backed Agent tool without weakening parsing", async () => {
    let received: unknown;
    const tool = createDynamicFamilyBuildTool({
      submit: async (value) => {
        received = value;
        return { ok: true, build_id: value.build_proposal.build_id };
      },
    });
    const result = await tool.execute(await submission());
    expect(tool.name).toBe("submit_dynamic_family_build");
    expect(result.isError).not.toBe(true);
    expect(received).toMatchObject({ execution_backend: "in_process_unisolated" });

    const invalid = await submission();
    invalid.execution_backend = "sandbox";
    const rejected = await tool.execute(invalid);
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain("dynamic_build_rejected");
  });

  test("executes registered bytes through the total unisolated Core composition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dynamic-family-submit-"));
    try {
      await mkdir(path.join(root, "source_assets"), { recursive: true });
      await writeFile(path.join(root, "source_assets", "source.csv"), "record_id,value\nr1,1\n", "utf8");
      const registry = new SourceAssetRegistry("task_dynamic", root);
      const receipt = await registry.register({ sourceId: "source_dynamic", relativePath: "source_assets/source.csv" });
      const raw = await submission();
      raw.registered_sources = { source_binding: receipt.asset_ref.asset_id };
      raw.transform_source = `export const transform = { run({ inputs }) { const [input] = inputs; return { outputs: [{ handle: "out_0", table_id: "records", schema_ref: "schema_records", locator_ref: input.receipt_id, content: "record_id,value\\nr1,1\\n", row_count: 1 }] }; } };`;
      let parsed = await parseDynamicFamilyBuildSubmission(raw);
      await expect(submitDynamicFamilyBuild({
        taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
        sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      })).rejects.toThrow(/Core acquisition provenance/);
      await registry.registerCoreAcquisitionProvenance(receipt, {
        provider_id: "fixture.files.v1",
        implementation_digest: A,
        request_identity_digest: B,
      });
      let expectedDigest = "";
      await expect(submitDynamicFamilyBuild({
        taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
        sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      })).rejects.toThrow(/Host-compiled descriptor ([0-9a-f]{64})/);
      try {
        await submitDynamicFamilyBuild({
          taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
          sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
        });
      } catch (error) {
        expectedDigest = /([0-9a-f]{64})/.exec((error as Error).message)?.[1] ?? "";
      }
      const proposal = raw.build_proposal as { transform_refs: Array<{ digest: string }> };
      proposal.transform_refs[0]!.digest = expectedDigest;
      parsed = await parseDynamicFamilyBuildSubmission(raw);
      const result = await submitDynamicFamilyBuild({
        taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
        sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      });
      expect(result.receipt.sandbox_backend).toBe("in_process_unisolated");
      expect(result.operationResult.output_summary).toMatchObject({ tables: { records: { row_count: 1 } } });
      expect(result.materialization.candidate.tables[0]?.definition.table_id).toBe("records");
      const published = await publishDynamicFamily({
        taskId: "task_dynamic", taskRoot: root,
        workspaceRoot: path.join(root, "agent-workspace"),
        buildId: parsed.build_proposal.build_id,
        execution: result,
        validationProfileRef: parsed.family_spec.validation_policy_ref,
      });
      expect(published.validation.status).toBe("passed");
      expect(published.assessment.product_status).toBe("publishable");
      expect(published.publication.publication.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(published.manifest.artifacts.map((artifact) => artifact.role)).toContain("provenance");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects sandbox claims, direct paths, examples, and unknown fields", async () => {
    const sandbox = await submission();
    sandbox.execution_backend = "container";
    await expect(parseDynamicFamilyBuildSubmission(sandbox)).rejects.toThrow(/explicit/);
    const directPath = await submission();
    directPath.registered_sources = { source_binding: "workspace/data.csv" };
    await expect(parseDynamicFamilyBuildSubmission(directPath)).rejects.toThrow(/asset_<sha256>/);
    const example = await submission();
    example.family_spec = { ...(example.family_spec as FamilySpec), scope: "example" };
    await expect(parseDynamicFamilyBuildSubmission(example)).rejects.toThrow(/example|digest/);
  });

  test("rejects accessors, Proxies, and symbols without reads", async () => {
    let reads = 0;
    const accessor = await submission();
    Object.defineProperty(accessor, "transform_source", {
      enumerable: true,
      get() { reads += 1; return "malicious"; },
    });
    await expect(parseDynamicFamilyBuildSubmission(accessor)).rejects.toThrow(/data property/);
    expect(reads).toBe(0);
    const proxy = new Proxy(await submission(), {
      get() { reads += 1; return undefined; },
    });
    await expect(parseDynamicFamilyBuildSubmission(proxy)).rejects.toThrow(/non-Proxy/);
    expect(reads).toBe(0);
    const symbol = { ...await submission(), [Symbol("sandbox")]: true };
    await expect(parseDynamicFamilyBuildSubmission(symbol)).rejects.toThrow(/unknown/);
  });
});
