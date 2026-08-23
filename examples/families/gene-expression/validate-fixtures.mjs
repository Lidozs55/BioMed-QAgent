import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeFamilySpecDigest,
  parseFamilySpec,
  verifyFamilySpecDigest,
} from "../../../packages/contracts/dist/index.js";
import {
  assetIdFromSha256,
} from "../../../server/dist/dataset/adapters/identity.js";
import {
  createDatasetIdentityRecords,
  createSampleIdentity,
} from "../../../server/dist/dataset/identity/index.js";

import { buildArtifacts } from "./generate-fixtures.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HEX_64 = /^[0-9a-f]{64}$/;
const ASSET_ID = /^asset_[0-9a-f]{64}$/;
const DATASET_ID = /^ds_[0-9a-f]{64}$/;
const DATASET_REVISION_ID = /^dsrev_[0-9a-f]{64}$/;
const FORBIDDEN_FILE_SUFFIXES = [
  ["dataset", "-", "transform", ".example.json"].join(""),
  ["transform", "-", "source.txt"].join(""),
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCsv(text) {
  const lines = text.trimEnd().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => Object.fromEntries(
    line.split(",").map((value, index) => [headers[index], value]),
  ));
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(pathname));
    else files.push(pathname);
  }
  return files;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

async function validateGeneratedArtifacts(files) {
  const expected = await buildArtifacts();
  for (const [relativePath, expectedBytes] of expected) {
    const actualBytes = await readFile(path.join(ROOT, relativePath), "utf8");
    invariant(actualBytes === expectedBytes, `generated artifact drift: ${relativePath}`);
  }
  const expectedPaths = new Set(expected.keys());
  for (const file of files) {
    const relativePath = path.relative(ROOT, file).replaceAll("\\", "/");
    if (relativePath.includes("/fixtures/") || (relativePath.endsWith(".json") && relativePath !== "package.json")) {
      invariant(expectedPaths.has(relativePath), `unmanaged generated artifact: ${relativePath}`);
    }
  }
}

async function validateFamilySpec() {
  const raw = await readJson("family-spec.example.json");
  const parsed = parseFamilySpec(raw, "$family_spec");
  invariant(parsed.scope === "example", "FamilySpec scope must be example");
  invariant(parsed.transform_capability_refs.length === 0, "retrieval FamilySpec capabilities must be empty");
  invariant(await verifyFamilySpecDigest(parsed), "FamilySpec digest verification failed");
  invariant(
    await computeFamilySpecDigest(parsed) === parsed.canonical_digest,
    "FamilySpec digest does not match the contracts helper",
  );
  return parsed;
}

async function validateCatalog(familySpec) {
  const catalog = await readJson("catalog.json");
  invariant(catalog.scope === "example", "catalog scope must be example");
  invariant(catalog.status === "submitted", "catalog status must be submitted");
  invariant(catalog.executable === false, "catalog must be non-executable");
  invariant(Array.isArray(catalog.entries) && catalog.entries.length === 1, "catalog must contain one entry");
  const [entry] = catalog.entries;
  invariant(entry.kind === "family_spec", "catalog entry must be FamilySpec metadata");
  invariant(entry.metadata_only === true, "catalog entry must be metadata-only");
  invariant(entry.scope === "example", "catalog entry scope must be example");
  invariant(entry.status === "submitted", "catalog entry status must be submitted");
  invariant(entry.executable === false, "catalog entry must be non-executable");
  invariant(entry.id === familySpec.family_spec_id, "catalog FamilySpec id mismatch");
  invariant(entry.version === familySpec.semantic_version, "catalog FamilySpec version mismatch");
  invariant(entry.digest === familySpec.canonical_digest, "catalog FamilySpec digest mismatch");
}

function assertUnique(rows, fields, label) {
  const keys = rows.map((row) => fields.map((field) => row[field]).join("\u001f"));
  invariant(new Set(keys).size === keys.length, `${label} primary key is not unique`);
}

async function validateVariant(variant) {
  const metadata = await readJson(`${variant}/retrieval-metadata.json`);
  const identity = await readJson(`${variant}/identity.json`);
  const assertions = await readJson(`${variant}/identity-assertions.json`);
  const sketch = await readJson(`${variant}/retrieval-source-sketch.json`);

  invariant(metadata.scope === "example", `${variant} metadata scope must be example`);
  invariant(metadata.status === "submitted", `${variant} metadata status must be submitted`);
  invariant(metadata.executable === false, `${variant} metadata must be non-executable`);
  invariant(sketch.scope === "example", `${variant} sketch scope must be example`);
  invariant(sketch.status === "submitted", `${variant} sketch status must be submitted`);
  invariant(sketch.executable === false, `${variant} sketch must be non-executable`);

  const carriers = [];
  for (const carrier of identity.carrier_assets) {
    const bytes = await readFile(path.join(ROOT, carrier.path));
    const digest = sha256(bytes);
    invariant(HEX_64.test(carrier.sha256), `${variant} carrier sha256 is not lowercase hex64`);
    invariant(carrier.sha256 === digest, `${variant} carrier byte digest mismatch: ${carrier.path}`);
    invariant(carrier.asset_id === assetIdFromSha256(digest), `${variant} carrier asset id mismatch`);
    invariant(ASSET_ID.test(carrier.asset_id), `${variant} carrier asset id format mismatch`);
    carriers.push(carrier.asset_id);
  }

  const expectedIdentities = createDatasetIdentityRecords({
    sourceNamespace: identity.source_namespace,
    canonicalAccessions: identity.canonical_accessions,
    revisionToken: identity.revision_token,
    providerSnapshot: identity.provider_snapshot,
    carrierAssetIds: carriers,
  });
  invariant(
    JSON.stringify(identity.dataset_identity_records) === JSON.stringify(expectedIdentities),
    `${variant} dataset identity does not match the server canonical helper`,
  );
  invariant(identity.sample_identities.every((sample) =>
    JSON.stringify(sample) === JSON.stringify(createSampleIdentity({
      datasetRevisionId: sample.dataset_revision_id,
      sampleId: sample.sample_id,
    }))), `${variant} sample identity does not match the server canonical helper`);

  invariant(DATASET_ID.test(assertions.dataset_id), `${variant} dataset id format mismatch`);
  invariant(DATASET_REVISION_ID.test(assertions.dataset_revision_id), `${variant} revision id format mismatch`);
  invariant(assertions.dataset_id === expectedIdentities[0].dataset_id, `${variant} dataset id assertion mismatch`);
  invariant(
    assertions.dataset_revision_id === expectedIdentities[0].dataset_revision_id,
    `${variant} revision id assertion mismatch`,
  );
  invariant(
    JSON.stringify(assertions.carrier_asset_ids) === JSON.stringify(expectedIdentities.map((item) => item.asset_id)),
    `${variant} carrier closure assertion mismatch`,
  );

  const expression = parseCsv(await readFile(path.join(ROOT, `${variant}/fixtures/expected/expression.csv`), "utf8"));
  const samples = parseCsv(await readFile(path.join(ROOT, `${variant}/fixtures/expected/samples.csv`), "utf8"));
  const datasets = parseCsv(await readFile(path.join(ROOT, `${variant}/fixtures/expected/datasets.csv`), "utf8"));
  invariant(expression.length === assertions.expected_expression_rows, `${variant} expression row count mismatch`);
  assertUnique(expression, assertions.primary_key_fields, `${variant} expression`);
  assertUnique(samples, ["dataset_revision_id", "sample_id"], `${variant} samples`);
  assertUnique(datasets, ["dataset_revision_id"], `${variant} datasets`);
  invariant(expression.every((row) => row.dataset_id === assertions.dataset_id), `${variant} expression dataset mismatch`);
  invariant(expression.every((row) => row.dataset_revision_id === assertions.dataset_revision_id), `${variant} expression revision mismatch`);
  invariant(expression.every((row) => ASSET_ID.test(row.asset_id)), `${variant} expression asset format mismatch`);
  invariant(samples.every((row) => row.dataset_revision_id === assertions.dataset_revision_id), `${variant} sample closure mismatch`);
  invariant(datasets[0].carrier_asset_ids === assertions.carrier_asset_ids.join("|"), `${variant} dataset carrier closure mismatch`);

  for (const artifact of metadata.artifacts) {
    const bytes = await readFile(path.join(ROOT, artifact.path));
    invariant(artifact.sha256 === sha256(bytes), `${variant} artifact digest mismatch: ${artifact.path}`);
    invariant(artifact.size_bytes === bytes.byteLength, `${variant} artifact size mismatch: ${artifact.path}`);
  }

  if (variant === "geo-probe") {
    invariant(sketch.probe_level_supported === true, "GEO probe sketch must support probe rows");
    const mappingAssertions = await readJson(`${variant}/probe-mapping-assertions.json`);
    const mappings = parseCsv(await readFile(path.join(ROOT, `${variant}/fixtures/expected/probe_gene_mapping.csv`), "utf8"));
    assertUnique(mappings, ["mapping_assertion_id"], "GEO probe mapping");
    invariant(mappings.length === mappingAssertions.expected_mapping_rows, "GEO probe mapping row count mismatch");
    invariant(mappings.every((row) => row.annotation_asset_id === mappingAssertions.annotation_asset_id), "GEO annotation asset closure mismatch");
    const mappedProbes = new Set(mappings.map((row) => row.probe_id));
    const expressionProbes = new Set(expression.map((row) => row.probe_id));
    invariant(expressionProbes.size === mappingAssertions.expected_expression_probes, "GEO expression probe count mismatch");
    invariant([...expressionProbes].every((probe) => mappedProbes.has(probe)), "GEO expression probe lacks mapping assertion");
  } else {
    invariant(sketch.probe_level_supported === false, `${variant} must not advertise probe rows`);
    if (variant === "gdc-gene") {
      invariant(metadata.probe_mapping_support === "unsupported", "GDC must explicitly mark probe mapping unsupported");
    }
  }
}

async function main() {
  const files = await walk(ROOT);
  for (const file of files) {
    const relativePath = path.relative(ROOT, file).replaceAll("\\", "/");
    invariant(
      !FORBIDDEN_FILE_SUFFIXES.includes(path.basename(file)),
      `forbidden file: ${relativePath}`,
    );
    const text = await readFile(file, "utf8");
    if (file.endsWith(".json")) JSON.parse(text);
  }

  await validateGeneratedArtifacts(files);
  const familySpec = await validateFamilySpec();
  await validateCatalog(familySpec);
  await validateVariant("geo-gene");
  await validateVariant("geo-probe");
  await validateVariant("gdc-gene");
  console.log(`Validated ${files.length} retrieval-example files with real contracts and server identity helpers.`);
}

await main();
