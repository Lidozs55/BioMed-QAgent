/**
 * Phase 4 step 9 (publication) parity checks: the release-invariants gate
 * (mirror ``backend/tests/test_dataset_invariants.py``), the role-based
 * manifest builder and deterministic digest (mirror
 * ``backend/tests/test_dataset_manifest.py``) and atomic publication
 * promotion (mirror the publish path of
 * ``backend/tests/test_dataset_expression_runner.py``).  Vitest-free so the
 * same checks run under vitest and as a plain Node script.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { deepEqual } from "./contract-parity.js";
import type { JsonValue } from "@biomed/contracts";
import {
  parseDatasetBuildSpec,
  parseDatasetManifest,
  parseDatasetPublication,
  parseManifestArtifactEntry,
  parseSourceAsset,
  parseValidationResult,
  type ArtifactRole,
  type DataBatch,
  type DatasetBuildSpec,
  type DatasetManifest,
  type SourceAsset,
  type ValidationResult,
} from "../src/dataset/contracts/index.js";
import { BuildError } from "../src/dataset/adapters/errors.js";
import { getAdapter } from "../src/dataset/adapters/index.js";
import { sha256File } from "../src/dataset/adapters/hashing.js";
import { buildGeneExpressionSchema } from "../src/dataset/schema/index.js";
import {
  canonicalize,
  expressionNormalizationV1,
  type CanonicalizationResult,
} from "../src/dataset/canonicalizer/index.js";
import { integrate, type IntegrationResult } from "../src/dataset/integrator/index.js";
import {
  assembleManifest,
  buildConfidenceSummary,
  buildProvenanceDocument,
  computeProvenanceCoverage,
  packageDigest,
  writeManifest,
  MANIFEST_FILE,
  PROVENANCE_FILE,
  SCHEMA_FILE,
} from "../src/dataset/publish/manifest.js";
import {
  checkReleaseInvariants,
  findLatestPublication,
} from "../src/dataset/publish/invariants.js";
import {
  PublicationRefusedError,
  promotePublication,
  PUBLICATION_REFUSED_PREFIX,
} from "../src/dataset/publish/publisher.js";
import { pythonJsonDumps } from "../src/dataset/runtime/digests.js";

function check(issues: string[], condition: boolean, message: string): void {
  if (!condition) issues.push(message);
}

function checkDeepEqual(
  issues: string[],
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (!deepEqual(actual, expected)) {
    issues.push(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function scratchOutputRoot(prefix = "publication-parity-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const DIGEST = "a".repeat(64);
const PRIMARY_CONTENT = "gene_id\texpression_value\nTP53\t1.5\n";

function asPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Shared build-workspace helpers (mirror the Python test module helpers)
// ---------------------------------------------------------------------------

function writeProvenance(outputDir: string, sourceCount = 2): string {
  const path = join(outputDir, PROVENANCE_FILE);
  writeFileSync(
    path,
    JSON.stringify({
      schema_ref: "gene_expression.long.v1",
      sources: Array.from({ length: sourceCount }, (_, index) => ({
        binding_id: `binding_${index}`,
        asset_id: `asset_${index}` + "0".repeat(56),
        source_id: `src_${index}`,
        logical_file: `f${index}.tsv`,
        sha256: DIGEST,
      })),
    }) + "\n",
    "utf8",
  );
  return path;
}

function materializePrimary(outputDir: string, content = PRIMARY_CONTENT): string {
  const path = join(outputDir, "merged", "primary.csv");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function entryFor(
  outputDir: string,
  artifactId: string,
  role: ArtifactRole,
  path: string,
  mediaType = "text/csv",
) {
  return parseManifestArtifactEntry({
    schema_version: "1.0",
    artifact_id: artifactId,
    role,
    relative_path: asPosix(relative(outputDir, path)),
    media_type: mediaType,
    size_bytes: statSync(path).size,
    sha256: sha256File(path),
  });
}

function manifestFor(
  outputDir: string,
  options: {
    sourceCount?: number;
    withProvenanceArtifact?: boolean;
    provenanceRelpath?: string;
    primaryContent?: string;
  } = {},
): DatasetManifest {
  const sourceCount = options.sourceCount ?? 2;
  const provenanceRelpath = options.provenanceRelpath ?? PROVENANCE_FILE;
  const entries = [
    entryFor(
      outputDir,
      "artifact_primary",
      "primary_dataset",
      materializePrimary(outputDir, options.primaryContent),
    ),
  ];
  if (options.withProvenanceArtifact ?? true) {
    const provenancePath = join(outputDir, provenanceRelpath);
    if (existsSync(provenancePath)) {
      entries.push(
        entryFor(outputDir, "artifact_prov", "provenance", provenancePath, "application/json"),
      );
    } else {
      // Declared artifact whose file is absent (missing-on-disk case).
      entries.push(
        parseManifestArtifactEntry({
          schema_version: "1.0",
          artifact_id: "artifact_prov",
          role: "provenance",
          relative_path: provenanceRelpath,
          media_type: "application/json",
          size_bytes: 10,
          sha256: DIGEST,
        }),
      );
    }
  }
  const digest = packageDigest(entries);
  return parseDatasetManifest({
    schema_version: "1.0",
    manifest_id: `manifest_${digest.slice(0, 16)}`,
    task_id: "task_test",
    build_id: "build_test",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    row_count: 4,
    sha256: digest,
    artifacts: entries,
    source_summary: {},
    validation_summary: {},
    confidence_summary: {},
    provenance_summary: { source_count: sourceCount },
  });
}

function validationFor(status: "passed" | "failed" = "passed"): ValidationResult {
  return parseValidationResult({
    schema_version: "1.0",
    manifest_digest: DIGEST,
    profile_ref: "gene_expression.release.v1",
    status,
    checked_count: 8,
    failed_count: status === "passed" ? 0 : 1,
    report_path: null,
  });
}

function writePublication(
  publishDir: string,
  name: string,
  publicationId: string,
  publishedAt: string,
): void {
  const versionDir = join(publishDir, name);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    join(versionDir, "publication.json"),
    JSON.stringify({
      publication_id: publicationId,
      manifest_ref: `manifest_${name}`,
      validation_result_ref: "validation_report.json",
      published_at: publishedAt,
    }) + "\n",
    "utf8",
  );
}
// ---------------------------------------------------------------------------
// Release invariants (test_dataset_invariants.py)
// ---------------------------------------------------------------------------

export async function checkInvariantsParity(options: { outputRoot: string }): Promise<string[]> {
  const issues: string[] = [];
  const outputRoot = options.outputRoot;

  // test_all_three_invariants_pass
  {
    const out = join(outputRoot, "pass");
    mkdirSync(out, { recursive: true });
    writeProvenance(out);
    const result = await checkReleaseInvariants({
      manifest: manifestFor(out),
      validation: validationFor(),
      outputDir: out,
    });
    check(issues, result.passed, "invariants: all three must pass");
    check(issues, result.provenance_closed, "invariants: provenance_closed");
    check(issues, result.profile_passed, "invariants: profile_passed");
    check(issues, result.atomic_promotion_ready, "invariants: atomic_promotion_ready");
    check(issues, result.artifacts_intact, "invariants: artifacts_intact");
    check(issues, result.violations.length === 0, `invariants: no violations (got ${JSON.stringify(result.violations)})`);
  }

  // test_missing_provenance_artifact_fails
  {
    const out = join(outputRoot, "no-prov-artifact");
    mkdirSync(out, { recursive: true });
    const result = await checkReleaseInvariants({
      manifest: manifestFor(out, { withProvenanceArtifact: false }),
      validation: validationFor(),
      outputDir: out,
    });
    check(issues, !result.passed, "no provenance artifact: not passed");
    check(issues, !result.provenance_closed, "no provenance artifact: provenance not closed");
    check(
      issues,
      result.violations.some((violation) => violation.includes("no provenance artifact")),
      "no provenance artifact: violation message",
    );
  }

  // test_provenance_document_missing_on_disk_fails
  {
    const out = join(outputRoot, "prov-missing-disk");
    mkdirSync(out, { recursive: true });
    // Artifact declared, file absent -> missing-on-disk violation.
    const result = await checkReleaseInvariants({
      manifest: manifestFor(out),
      validation: validationFor(),
      outputDir: out,
    });
    check(issues, !result.passed, "provenance missing on disk: not passed");
    check(issues, !result.provenance_closed, "provenance missing on disk: provenance not closed");
    check(
      issues,
      result.violations.some((violation) => violation.includes("missing on disk")),
      "provenance missing on disk: violation message",
    );
  }

  // test_provenance_source_coverage_fails
  {
    const out = join(outputRoot, "prov-coverage");
    mkdirSync(out, { recursive: true });
    writeProvenance(out, 1); // only 1 of 2 sources
    const result = await checkReleaseInvariants({
      manifest: manifestFor(out, { sourceCount: 2 }),
      validation: validationFor(),
      outputDir: out,
    });
    check(issues, !result.passed, "source coverage: not passed");
    check(issues, !result.provenance_closed, "source coverage: provenance not closed");
    check(
      issues,
      result.violations.some((violation) => violation.includes("lists 1 source asset(s)")),
      "source coverage: violation message",
    );
  }

  // test_failed_profile_blocks_promotion
  {
    const out = join(outputRoot, "failed-profile");
    mkdirSync(out, { recursive: true });
    writeProvenance(out);
    const result = await checkReleaseInvariants({
      manifest: manifestFor(out),
      validation: validationFor("failed"),
      outputDir: out,
    });
    check(issues, !result.passed, "failed profile: not passed");
    check(issues, !result.profile_passed, "failed profile: profile not passed");
    check(
      issues,
      result.violations.some((violation) => violation.includes("validation status is 'failed'")),
      "failed profile: violation message",
    );
  }

  // test_duplicate_digest_version_blocks_republish
  {
    const out = join(outputRoot, "dup-digest");
    mkdirSync(out, { recursive: true });
    writeProvenance(out);
    const manifest = manifestFor(out);
    const duplicate = join(out, "publish", `build_test_${manifest.sha256.slice(0, 16)}`);
    mkdirSync(duplicate, { recursive: true });
    writeFileSync(join(duplicate, "dataset_manifest.json"), "{}", "utf8");
    const result = await checkReleaseInvariants({
      manifest: manifestFor(out),
      validation: validationFor(),
      outputDir: out,
    });
    check(issues, !result.passed, "duplicate digest: not passed");
    check(issues, !result.atomic_promotion_ready, "duplicate digest: not atomic ready");
    check(
      issues,
      result.violations.some((violation) => violation.includes("refusing to republish")),
      "duplicate digest: violation message",
    );
  }

  // test_new_digest_version_is_allowed
  {
    const out = join(outputRoot, "new-digest");
    mkdirSync(out, { recursive: true });
    writeProvenance(out);
    const prior = join(out, "publish", "build_test_priorversion");
    mkdirSync(prior, { recursive: true });
    writeFileSync(join(prior, "dataset_manifest.json"), "{}", "utf8");
    const result = await checkReleaseInvariants({
      manifest: manifestFor(out),
      validation: validationFor(),
      outputDir: out,
    });
    check(issues, result.passed, "new digest: passed");
    check(issues, result.atomic_promotion_ready, "new digest: atomic ready");
  }

  // test_manifest_artifact_missing_fails / tampered
  {
    const out = join(outputRoot, "artifact-inventory");
    mkdirSync(out, { recursive: true });
    writeProvenance(out);
    // B4 tampered: a manifest artifact edited after validation (size/hash
    // change) must fail the release gate before promotion.
    const tampered = manifestFor(out);
    writeFileSync(join(out, "merged", "primary.csv"), "tampered-with-data!!", "utf8");
    const result = await checkReleaseInvariants({
      manifest: tampered,
      validation: validationFor(),
      outputDir: out,
    });
    check(issues, !result.passed, "artifact tampered: not passed");
    check(issues, !result.artifacts_intact, "artifact tampered: not intact");
    check(
      issues,
      result.violations.some(
        (violation) => violation.includes("size") || violation.includes("sha256 mismatch"),
      ),
      "artifact tampered: violation message",
    );
    // B4 missing: every manifest artifact must exist on disk before
    // promotion; Python builds the manifest first, then deletes the file.
    const missingManifest = manifestFor(out);
    rmSync(join(out, "merged", "primary.csv"));
    const missing = await checkReleaseInvariants({
      manifest: missingManifest,
      validation: validationFor(),
      outputDir: out,
    });
    check(issues, !missing.passed, "artifact missing: not passed");
    check(issues, !missing.artifacts_intact, "artifact missing: not intact");
    check(
      issues,
      missing.violations.some(
        (violation) => violation.includes("merged/primary.csv") && violation.includes("missing"),
      ),
      "artifact missing: violation message",
    );
  }
  // find_latest_publication: newest by published_at, never lexicographic
  {
    const publishDir = join(outputRoot, "find-latest-time");
    mkdirSync(publishDir, { recursive: true });
    writePublication(publishDir, "build_zzz_1", "pub_build_zzz_1", "2026-08-07T10:00:00+00:00");
    writePublication(publishDir, "build_aaa_2", "pub_build_aaa_2", "2026-08-07T11:00:00+00:00");
    check(issues, findLatestPublication(publishDir) === "pub_build_aaa_2", "find latest: time wins over lexicographic order");
  }

  // find_latest_publication: empty dir -> null
  {
    const publishDir = join(outputRoot, "find-latest-empty");
    mkdirSync(publishDir, { recursive: true });
    check(issues, findLatestPublication(publishDir) === null, "find latest: empty publish dir returns null");
  }

  // find_latest_publication: skips corrupt records
  {
    const publishDir = join(outputRoot, "find-latest-corrupt");
    mkdirSync(publishDir, { recursive: true });
    writePublication(publishDir, "build_valid", "pub_build_valid", "2026-08-07T12:00:00+00:00");
    const corrupt = join(publishDir, "build_corrupt");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "publication.json"), "not json", "utf8");
    check(issues, findLatestPublication(publishDir) === "pub_build_valid", "find latest: corrupt records are skipped");
  }

  // find_latest_publication: build-scoped (test_dataset_expression_runner.py)
  {
    const publishDir = join(outputRoot, "find-latest-scoped");
    mkdirSync(publishDir, { recursive: true });
    writePublication(publishDir, "build_a_aaaaaaaaaaaaaaaa", "pub_build_a_aaaaaaaaaaaaaaaa", "2026-08-01T00:00:00+00:00");
    writePublication(publishDir, "build_b_bbbbbbbbbbbbbbbb", "pub_build_b_bbbbbbbbbbbbbbbb", "2026-08-01T00:00:00+00:00");
    writePublication(publishDir, "build_a_cccccccccccccccc", "pub_build_a_cccccccccccccccc", "2026-08-01T00:00:01+00:00");
    check(issues, findLatestPublication(publishDir, "build_a") === "pub_build_a_cccccccccccccccc", "find latest scoped: build_a sees its newest");
    check(issues, findLatestPublication(publishDir, "build_b") === "pub_build_b_bbbbbbbbbbbbbbbb", "find latest scoped: build_b sees its newest");
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Manifest builder and deterministic digest (test_dataset_manifest.py)
// ---------------------------------------------------------------------------

function sourceAssetFromFixture(
  fixturesRoot: string,
  relativePath: string,
  sourceId: string,
): SourceAsset {
  const bytes = readFileSync(join(fixturesRoot, relativePath));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  return parseSourceAsset({
    schema_version: "1.0",
    asset_id: `asset_${checksum}`,
    kind: "source",
    relative_path: `source_assets/${relativePath}`,
    sha256: checksum,
    size_bytes: bytes.length,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
    source_id: sourceId,
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
  });
}

function parseAdapterBatch(options: {
  fixturesRoot: string;
  fixture: string;
  adapterId: string;
  bindingId: string;
  outputDir: string;
}): Promise<DataBatch> {
  const adapter = getAdapter(options.adapterId);
  const asset = sourceAssetFromFixture(
    options.fixturesRoot,
    options.fixture,
    `src_${options.bindingId}`,
  );
  return adapter.parse(asset, join(options.fixturesRoot, options.fixture), {
    buildId: "build_test",
    bindingId: options.bindingId,
    schemaRef: "gene_expression.long.v1",
    outputDir: options.outputDir,
  });
}

async function canonical(options: {
  fixturesRoot: string;
  fixture: string;
  adapterId: string;
  bindingId: string;
  outputDir: string;
}): Promise<CanonicalizationResult> {
  const batch = await parseAdapterBatch(options);
  return canonicalize({
    batch,
    schema: buildGeneExpressionSchema(),
    profile: expressionNormalizationV1(),
    outputDir: options.outputDir,
  });
}

async function buildChain(options: {
  fixturesRoot: string;
  outputDir: string;
}): Promise<{
  schema: ReturnType<typeof buildGeneExpressionSchema>;
  results: CanonicalizationResult[];
  integration: IntegrationResult;
  assets: Record<string, SourceAsset>;
}> {
  const schema = buildGeneExpressionSchema();
  const assets = {
    binding_gdc: sourceAssetFromFixture(options.fixturesRoot, "gdc/gdc_expression.tsv", "src_gdc"),
    binding_xena: sourceAssetFromFixture(
      options.fixturesRoot,
      "ncbi/gse178352/xena_matrix.tsv",
      "src_xena",
    ),
  };
  const results = [
    await canonical({
      fixturesRoot: options.fixturesRoot,
      fixture: "gdc/gdc_expression.tsv",
      adapterId: "gdc.expression.v1",
      bindingId: "binding_gdc",
      outputDir: options.outputDir,
    }),
    await canonical({
      fixturesRoot: options.fixturesRoot,
      fixture: "ncbi/gse178352/xena_matrix.tsv",
      adapterId: "xena.matrix.v1",
      bindingId: "binding_xena",
      outputDir: options.outputDir,
    }),
  ];
  const integration = await integrate({
    results,
    mergeStrategy: "append_by_canonical_row",
    schema,
    buildId: "build_test",
    outputDir: options.outputDir,
  });
  return { schema, results, integration, assets };
}

function spec(): DatasetBuildSpec {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: "build_test",
    objective: "compare TP53 expression",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [
      {
        schema_version: "1.0",
        binding_id: "binding_gdc",
        source: "gdc",
        acquisition: {
          schema_version: "1.0",
          mode: "builtin",
          provider_id: "gdc.files.v1",
        },
        adapter_id: "gdc.expression.v1",
      },
    ],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

async function assembleIn(options: {
  fixturesRoot: string;
  outputDir: string;
  auditPaths?: readonly string[];
  sourceSummary?: Record<string, JsonValue>;
}): Promise<{ manifest: DatasetManifest; provenancePath: string }> {
  const { schema, results, integration, assets } = await buildChain(options);
  const provenancePath = await buildProvenanceDocument({
    schema,
    integration,
    canonicalResults: results,
    sourceAssets: assets,
    outputDir: options.outputDir,
  });
  const auditPaths = options.auditPaths ?? results.flatMap((result) => result.auditPaths);
  const manifest = await assembleManifest({
    taskId: "task_test",
    buildId: "build_test",
    spec: spec(),
    schema,
    integration,
    canonicalResults: results,
    provenancePath,
    auditPaths: auditPaths.filter((path) => existsSync(path)),
    validation: validationFor(),
    sourceSummary: options.sourceSummary ?? {},
    outputDir: options.outputDir,
  });
  return { manifest, provenancePath };
}
export async function checkManifestParity(options: {
  fixturesRoot: string;
  outputRoot: string;
}): Promise<string[]> {
  const issues: string[] = [];
  const { fixturesRoot, outputRoot } = options;

  // test_manifest_role_inventory
  {
    const out = join(outputRoot, "role-inventory");
    mkdirSync(out, { recursive: true });
    const { manifest } = await assembleIn({
      fixturesRoot,
      outputDir: out,
      sourceSummary: {
        binding_gdc: { row_count: 4 },
        binding_xena: { row_count: 4 },
      },
    });
    const roles = new Set(manifest.artifacts.map((entry) => entry.role));
    check(issues, roles.has("primary_dataset"), "role inventory: primary_dataset present");
    check(issues, roles.has("schema"), "role inventory: schema present");
    check(issues, roles.has("provenance"), "role inventory: provenance present");
    check(issues, roles.has("audit_report"), "role inventory: audit_report present");
    const primaries = manifest.artifacts.filter((entry) => entry.role === "primary_dataset");
    check(issues, primaries.length === 1, "role inventory: exactly one primary");
    check(issues, primaries[0].relative_path === "merged/primary.csv", "role inventory: primary relative path");
    check(issues, manifest.row_count === 4, "role inventory: row_count is 4");
    checkDeepEqual(issues, manifest.provenance_summary["dedup_count"], 3, "role inventory: dedup_count");
    checkDeepEqual(issues, manifest.provenance_summary["conflict_count"], 1, "role inventory: conflict_count");
    const manifestPath = writeManifest(manifest, out);
    check(issues, existsSync(manifestPath) && manifestPath.endsWith(MANIFEST_FILE), "role inventory: manifest file written");
    check(issues, existsSync(join(out, SCHEMA_FILE)), "role inventory: schema file written");
    check(issues, existsSync(join(out, PROVENANCE_FILE)), "role inventory: provenance file written");
    const loaded = parseDatasetManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    check(issues, loaded.manifest_id === manifest.manifest_id, "role inventory: manifest file round-trips");
    check(issues, loaded.sha256 === manifest.sha256, "role inventory: manifest digest round-trips");
  }

  // test_manifest_digest_is_deterministic: identical artifact contents in a
  // fresh directory produce the same digest and manifest id.
  {
    const first = (await assembleIn({ fixturesRoot, outputDir: join(outputRoot, "digest-a") })).manifest;
    const second = (await assembleIn({ fixturesRoot, outputDir: join(outputRoot, "digest-b") })).manifest;
    check(issues, first.sha256 === second.sha256, "digest deterministic: sha256 equal");
    check(issues, first.manifest_id === second.manifest_id, "digest deterministic: manifest_id equal");
  }

  // test_package_digest_sorted_and_stable
  {
    const entries = [
      parseManifestArtifactEntry({
        schema_version: "1.0",
        artifact_id: "a2",
        role: "audit_report",
        relative_path: "z.csv",
        media_type: "text/csv",
        size_bytes: 1,
        sha256: "2".repeat(64),
      }),
      parseManifestArtifactEntry({
        schema_version: "1.0",
        artifact_id: "a1",
        role: "primary_dataset",
        relative_path: "a.csv",
        media_type: "text/csv",
        size_bytes: 1,
        sha256: "1".repeat(64),
      }),
    ];
    check(issues, packageDigest(entries) === packageDigest([...entries].reverse()), "package digest: order independent");
  }

  // test_provenance_document_backtraces
  {
    const out = join(outputRoot, "provenance-backtraces");
    mkdirSync(out, { recursive: true });
    const { provenancePath } = await assembleIn({ fixturesRoot, outputDir: out });
    const document = JSON.parse(readFileSync(provenancePath, "utf8")) as Record<string, unknown>;
    check(issues, document["schema_ref"] === "gene_expression.long.v1", "provenance: schema_ref");
    const sources = document["sources"] as Array<Record<string, unknown>>;
    check(issues, Array.isArray(sources) && sources.length === 2, "provenance: two sources");
    check(issues, String(sources[0]["asset_id"]).startsWith("asset_"), "provenance: asset_id prefix");
    const backtraces = document["sample_backtraces"] as Array<Record<string, unknown>>;
    check(issues, backtraces.length > 0 && backtraces[0]["gene_id"] === "TP53", "provenance: first backtrace gene TP53");
    const transforms = backtraces[0]["transforms"] as Array<Record<string, unknown>>;
    check(issues, transforms.length > 0 && transforms[0]["transform"] === "namespace_authorize", "provenance: first transform");
    check(issues, (document["field_mappings"] as unknown[]).length > 0, "provenance: field mappings present");
  }

  // test_compute_provenance_coverage
  {
    const primary = join(outputRoot, "coverage-primary.csv");
    writeFileSync(
      primary,
      "gene_id,sample_id,asset_id,expression_value\n" +
        "TP53,S1,asset_traced1,1.5\n" +
        "BRCA1,S2,asset_traced2,2.5\n" +
        "TP53,S3,,3.5\n" +
        "TP53,S4,asset_unknown,4.5\n",
      "utf8",
    );
    const coverage = await computeProvenanceCoverage(primary, new Set(["asset_traced1", "asset_traced2"]));
    check(issues, coverage.traced_rows === 2, "coverage: traced_rows 2");
    check(issues, coverage.untraced_rows === 2, "coverage: untraced_rows 2");
    check(issues, pythonJsonDumps(coverage.coverage_ratio) === "0.5", "coverage: ratio 0.5");
  }

  // test_build_confidence_summary_from_report / missing report
  {
    const out = join(outputRoot, "confidence-report");
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "confidence_report.csv"),
      "column,detector,applicable,statistic,anomaly,detail\n" +
        "expression_value,constant_column,true,,true,all values identical\n" +
        "expression_value,arithmetic_progression,true,,false,no sequence\n",
      "utf8",
    );
    const summary = await buildConfidenceSummary(out);
    checkDeepEqual(issues, summary["detected_anomaly_count"], 1, "confidence summary: anomaly count");
    check(issues, summary["report_file"] === "confidence_report.csv", "confidence summary: report file");
  }
  {
    const out = join(outputRoot, "confidence-missing");
    mkdirSync(out, { recursive: true });
    checkDeepEqual(issues, await buildConfidenceSummary(out), {}, "confidence summary: empty without report");
  }

  // test_artifact_id_includes_relative_path: identical bytes at two relative
  // paths must not collide (C3a); the id is deterministic per path.
  {
    const out = join(outputRoot, "artifact-id-collision");
    mkdirSync(join(out, "a"), { recursive: true });
    mkdirSync(join(out, "b"), { recursive: true });
    const first = join(out, "a", "dup.csv");
    const second = join(out, "b", "dup.csv");
    writeFileSync(first, "identical bytes\n", "utf8");
    writeFileSync(second, "identical bytes\n", "utf8");
    const firstManifest = (await assembleIn({
      fixturesRoot,
      outputDir: out,
      auditPaths: [first, second],
    })).manifest;
    const secondManifest = (await assembleIn({
      fixturesRoot,
      outputDir: out,
      auditPaths: [first, second],
    })).manifest;
    const auditIds = (manifest: DatasetManifest) =>
      Object.fromEntries(
        manifest.artifacts
          .filter((entry) => entry.role === "audit_report")
          .map((entry) => [entry.relative_path, entry.artifact_id]),
      );
    const ids = auditIds(firstManifest);
    const idsAgain = auditIds(secondManifest);
    check(issues, ids["a/dup.csv"] !== undefined && ids["b/dup.csv"] !== undefined, "artifact id: both dup audits present");
    check(issues, ids["a/dup.csv"] !== ids["b/dup.csv"], "artifact id: identical bytes at distinct paths differ");
    check(issues, (ids["a/dup.csv"] ?? "").startsWith("artifact_"), "artifact id: prefix");
    check(issues, (ids["a/dup.csv"] ?? "").length === "artifact_".length + 32, "artifact id: length");
    check(issues, ids["a/dup.csv"] === idsAgain["a/dup.csv"], "artifact id: stable for same relative path");
  }

  return issues;
}
// ---------------------------------------------------------------------------
// Atomic publication promotion (publish path of
// test_dataset_expression_runner.py)
// ---------------------------------------------------------------------------

function materializeBuild(
  outputDir: string,
  primaryContent = PRIMARY_CONTENT,
): { manifest: DatasetManifest; validation: ValidationResult } {
  mkdirSync(outputDir, { recursive: true });
  writeProvenance(outputDir);
  materializePrimary(outputDir, primaryContent);
  const manifest = manifestFor(outputDir, { primaryContent });
  writeManifest(manifest, outputDir);
  writeFileSync(join(outputDir, "validation_report.json"), "{}", "utf8");
  return { manifest, validation: validationFor() };
}

export async function checkPublisherParity(options: { outputRoot: string }): Promise<string[]> {
  const issues: string[] = [];
  const outputRoot = options.outputRoot;

  // Happy path: atomic promotion preserves artifact relative paths, copies
  // the manifest + validation report, and writes an immutable publication.
  {
    const out = join(outputRoot, "promote");
    mkdirSync(out, { recursive: true });
    const { manifest, validation } = materializeBuild(out);
    const publishedAt = "2026-08-07T12:00:00+00:00";
    const result = await promotePublication({ outputDir: out, manifest, validation, publishedAt });
    check(
      issues,
      result.publicationId === `pub_build_test_${manifest.sha256.slice(0, 16)}`,
      "promote: publication id",
    );
    check(issues, result.supersedesPublicationId === null, "promote: first publication supersedes none");
    const versionDir = join(out, "publish", `build_test_${manifest.sha256.slice(0, 16)}`);
    check(issues, existsSync(versionDir), "promote: version dir exists");
    for (const artifact of manifest.artifacts) {
      check(
        issues,
        existsSync(join(versionDir, artifact.relative_path)),
        `promote: artifact ${artifact.relative_path} preserved`,
      );
    }
    check(issues, existsSync(join(versionDir, MANIFEST_FILE)), "promote: manifest copied into version");
    check(issues, existsSync(join(versionDir, "validation_report.json")), "promote: validation report copied");
    const publication = parseDatasetPublication(
      JSON.parse(readFileSync(join(versionDir, "publication.json"), "utf8")),
    );
    check(issues, publication.publication_id === result.publicationId, "promote: publication record id");
    check(issues, publication.supersedes_publication_id === null, "promote: publication supersedes null");
    check(
      issues,
      existsSync(join(versionDir, publication.validation_result_ref)),
      "promote: validation_result_ref resolves inside version dir",
    );
    // The version directory is immutable: the output workspace primary must
    // be untouched by the promotion.
    check(issues, existsSync(join(out, "merged", "primary.csv")), "promote: source primary untouched");
  }

  // Supersede within the same build: a newer digest is a different version
  // directory and chains supersedes_publication_id.
  {
    const out = join(outputRoot, "promote-supersede");
    mkdirSync(out, { recursive: true });
    const first = materializeBuild(out, "gene_id\texpression_value\nTP53\t1.5\n");
    const firstResult = await promotePublication({
      outputDir: out,
      manifest: first.manifest,
      validation: first.validation,
      publishedAt: "2026-08-07T10:00:00+00:00",
    });
    const second = materializeBuild(out, "gene_id\texpression_value\nTP53\t2.5\n");
    const secondResult = await promotePublication({
      outputDir: out,
      manifest: second.manifest,
      validation: second.validation,
      publishedAt: "2026-08-07T11:00:00+00:00",
    });
    check(issues, secondResult.publicationId !== firstResult.publicationId, "supersede: distinct publication ids");
    check(issues, secondResult.supersedesPublicationId === firstResult.publicationId, "supersede: second supersedes first");
    check(
      issues,
      findLatestPublication(join(out, "publish"), "build_test") === secondResult.publicationId,
      "supersede: findLatestPublication returns newest",
    );
  }

  // Duplicate immutable version rejected (atomic promotion, C1).
  {
    const out = join(outputRoot, "promote-dup");
    mkdirSync(out, { recursive: true });
    const { manifest, validation } = materializeBuild(out);
    await promotePublication({
      outputDir: out,
      manifest,
      validation,
      publishedAt: "2026-08-07T10:00:00+00:00",
    });
    let threw = false;
    try {
      await promotePublication({
        outputDir: out,
        manifest,
        validation,
        publishedAt: "2026-08-07T11:00:00+00:00",
      });
    } catch (error) {
      threw = error instanceof BuildError && /already exists/.test(String(error.message));
    }
    check(issues, threw, "promote: duplicate version directory rejected");
  }

  // The release gate blocks promotion of a failed validation.
  {
    const out = join(outputRoot, "promote-gate-fail");
    mkdirSync(out, { recursive: true });
    const { manifest } = materializeBuild(out);
    let threw = false;
    try {
      await promotePublication({
        outputDir: out,
        manifest,
        validation: validationFor("failed"),
        publishedAt: "2026-08-07T10:00:00+00:00",
      });
    } catch (error) {
      threw = error instanceof BuildError && /release invariants failed/.test(String(error.message));
    }
    check(issues, threw, "promote: failed validation blocks promotion");
  }

  // H2: a pending-input gate that flips before the rename refuses the
  // promotion and leaves no version or stray staged directory.
  {
    const out = join(outputRoot, "promote-pending");
    mkdirSync(out, { recursive: true });
    const { manifest, validation } = materializeBuild(out);
    let refused = false;
    try {
      await promotePublication({
        outputDir: out,
        manifest,
        validation,
        pendingCheck: () => true,
        publishedAt: "2026-08-07T10:00:00+00:00",
      });
    } catch (error) {
      refused =
        error instanceof PublicationRefusedError &&
        String(error.message).startsWith(PUBLICATION_REFUSED_PREFIX);
    }
    check(issues, refused, "promote: pending check refuses promotion");
    const publishDir = join(out, "publish");
    check(
      issues,
      !existsSync(join(publishDir, `build_test_${manifest.sha256.slice(0, 16)}`)),
      "promote pending: no version dir on refusal",
    );
    const stray = readdirSync(publishDir).filter((name) => name.includes(".tmp"));
    check(issues, stray.length === 0, "promote pending: no stray staged dirs");
  }

  // PyFloat wire shape: pythonJsonDumps emits 1.0 for a 100% coverage ratio
  // (Python json.dumps(round(1.0, 4))), keeping the manifest JSON identical.
  {
    const primary = join(outputRoot, "pyfloat-primary.csv");
    writeFileSync(
      primary,
      "gene_id,sample_id,asset_id,expression_value\nTP53,S1,asset_x,1.5\n",
      "utf8",
    );
    const coverage = await computeProvenanceCoverage(primary, new Set(["asset_x"]));
    check(issues, coverage.traced_rows === 1 && coverage.untraced_rows === 0, "pyfloat: traced primary");
    check(issues, pythonJsonDumps(coverage.coverage_ratio) === "1.0", "pyfloat: 100% coverage serializes as 1.0");
    check(issues, pythonJsonDumps({ ratio: coverage.coverage_ratio }) === '{\n  "ratio": 1.0\n}', "pyfloat: nested ratio serializes as 1.0");
  }

  return issues;
}