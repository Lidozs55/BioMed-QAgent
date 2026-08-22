# Gene-expression retrieval examples

This directory is a **D-E1 static retrieval scope** for three source shapes:

- GEO gene-level expression;
- GEO probe-level expression plus a byte-bound platform annotation closure;
- GDC gene-level expression, explicitly without probe-level support.

The examples are `scope=example`, `status=submitted`, and `executable=false`.
They provide one declarative `FamilySpec`, source-carrier sketches, deterministic
identity assertions, and expected V2 tables. They are not runtime fixtures,
activation records, trust decisions, or production registrations.

## Generate and validate

Build the current contract and identity helpers first, then run:

```bash
pnpm --filter @biomed/contracts build
pnpm --filter @biomed/server build
node examples/families/gene-expression/generate-fixtures.mjs --write
node examples/families/gene-expression/validate-fixtures.mjs
node examples/families/gene-expression/generate-fixtures.mjs
```

The generator computes `FamilySpec.canonical_digest` only through
`computeFamilySpecDigest`. The validator parses the document with
`parseFamilySpec`, verifies it with `verifyFamilySpecDigest`, and recomputes the
same digest using the compiled exports under `packages/contracts/dist`.

Dataset, revision, asset, sample, record, and probe-mapping assertion identities
are produced or checked through the compiled server canonical helpers. Carrier
asset IDs are SHA-256 identities of the committed bytes. These checks establish
only internal consistency of this static example.

## Layout

- `family-spec.example.json`: the sole family contract document.
- `catalog.json`: one metadata-only `family_spec` entry.
- `<source>/retrieval-source-sketch.json`: retrieval source-shape guidance, not a
  declaration of executable behavior.
- `<source>/fixtures/input/`: tiny source carriers.
- `<source>/fixtures/expected/`: expected V2 tables.
- `<source>/identity*.json`: dataset/revision/carrier/sample and row-key vectors.
- `geo-probe/probe-mapping-assertions.json`: annotation closure and coverage
  assertions.

No D-E2 or D-E3 conclusion follows from these files.
