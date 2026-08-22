import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXAMPLE_ROOT,
  EXPECTED_PATHS,
  INPUT_PATH,
  assert,
  deriveFixture,
  jsonText,
  jsonlText,
  loadContracts,
  sha256Hex,
  validateFixtures,
} from "./validate-fixtures.mjs";

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(EXAMPLE_ROOT, relativePath), "utf8"));
}

async function readTextOrNull(relativePath) {
  try {
    return await readFile(path.join(EXAMPLE_ROOT, relativePath), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

const contracts = await loadContracts();
for (const api of [
  "parseFamilySpec",
  "computeFamilySpecDigest",
  "verifyFamilySpecDigest",
  "stableStringify",
]) {
  assert(typeof contracts[api] === "function", `missing contracts API ${api}`);
}

const inputBytes = await readFile(path.join(EXAMPLE_ROOT, INPUT_PATH));
const input = JSON.parse(inputBytes.toString("utf8"));
const derived = deriveFixture(input, inputBytes, contracts.stableStringify);
const familySource = await readJson("family-spec.example.json");
const parsedFamily = contracts.parseFamilySpec(familySource, "$family_spec");
const familyDigest = await contracts.computeFamilySpecDigest(parsedFamily);
const family = { ...parsedFamily, canonical_digest: familyDigest };
assert(await contracts.verifyFamilySpecDigest(family), "generated FamilySpec digest verification failed");

const expectedFiles = {};
const outputFacts = {};
for (const [table, relativePath] of Object.entries(EXPECTED_PATHS)) {
  const text = jsonlText(derived.rows[table], contracts.stableStringify);
  expectedFiles[relativePath] = text;
  outputFacts[table] = {
    path: relativePath,
    row_count: derived.rows[table].length,
    sha256: sha256Hex(Buffer.from(text, "utf8")),
  };
}

const metadata = {
  schema_version: "1.0",
  example_id: "bioactivity-measurement",
  family_id: "bioactivity_measurement",
  retrieval_only: true,
  host_availability: "unavailable",
  catalog: {
    kind: "family_spec",
    scope: "example",
    id: family.family_spec_id,
    version: family.semantic_version,
    digest: familyDigest,
    status: "submitted",
    executable: false,
  },
  claims: {
    dataset_transform: false,
    compiler_or_bundle: false,
    implementation_identity: false,
    host_receipt: false,
    core_admission: false,
    host_fixture: false,
    shadow: false,
    e3: false,
    publication: false,
  },
  contracts_api_dependencies: [
    "parseFamilySpec",
    "computeFamilySpecDigest",
    "verifyFamilySpecDigest",
    "stableStringify",
  ],
  identity: {
    input_path: INPUT_PATH,
    input_sha256: derived.input_sha256,
    source_asset_id: derived.source_asset_id,
    dataset_id: derived.dataset_id,
    dataset_revision_id: derived.dataset_revision_id,
    canonical_rules: {
      asset_id: "asset_<sha256(exact input fixture bytes)>",
      dataset_id: "ds_<sha256(stableStringify(dataset identity body))>",
      dataset_revision_id: "dsrev_<sha256(stableStringify(revision identity body))>",
      dataset_identity_body: contracts.stableStringify(derived.dataset_identity_body),
      revision_identity_body: contracts.stableStringify(derived.revision_identity_body),
      build_id_participates: false,
    },
  },
  expected_outputs: outputFacts,
  retrieval_tags: [
    "bioactivity-measurement",
    "multi-table",
    "compound-identity",
    "crosswalk",
    "token-preservation",
    "retrieval-only",
  ],
};

const targets = {
  "family-spec.example.json": jsonText(family),
  ...expectedFiles,
  "retrieval-metadata.json": jsonText(metadata),
};
const writeMode = process.argv.includes("--write");
let changes = 0;

for (const [relativePath, text] of Object.entries(targets)) {
  const previous = await readTextOrNull(relativePath);
  if (previous === text) {
    console.log(`current: ${relativePath}`);
    continue;
  }
  changes += 1;
  if (writeMode) {
    const absolutePath = path.join(EXAMPLE_ROOT, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, text, "utf8");
    console.log(`wrote: ${relativePath}`);
  } else {
    console.log(`would write: ${relativePath}`);
  }
}

if (writeMode) {
  console.log(`generate-fixtures.mjs: wrote ${changes} changed file(s); running validator`);
  await validateFixtures();
} else {
  console.log(`generate-fixtures.mjs: dry run, ${changes} file(s) would change`);
}
