import { describe, expect, test } from "vitest";

import {
  compareExpressionCompatibilityPartitions,
  createExpressionCompatibilityPartitionDescriptor,
  expressionCompatibilityMergeDomainKey,
  expressionCompatibilityPartitionKey,
  type ExpressionCompatibilityPartitionInput,
} from "../src/dataset/compat/partition.js";

const BASE_INPUT: ExpressionCompatibilityPartitionInput = {
  schema_ref: "expression_gene.v2",
  row_granularity: "gene_sample_measurement",
  taxon_id: "NCBITaxon:9606",
  organism: "Homo sapiens",
  feature_namespace: "ensembl_gene",
  measurement_type: "gene_expression",
  value_semantics: "normalized_expression",
  value_scale: "linear",
  expression_unit: "TPM",
  normalization_state: "source_normalized",
  reference_namespace: "GENCODE",
  reference_version: "v44",
  dataset_revision_id: `dsrev_${"a".repeat(64)}`,
};

function descriptor(
  overrides: Partial<ExpressionCompatibilityPartitionInput> = {},
) {
  return createExpressionCompatibilityPartitionDescriptor({
    ...BASE_INPUT,
    ...overrides,
  });
}

describe("family-host C-T6 expression compatibility partition primitive", () => {
  test("creates an immutable strict descriptor without canonicalizing unknown or null", () => {
    const unknown = descriptor({
      taxon_id: null,
      organism: "unknown",
      feature_namespace: null,
      value_scale: "unknown",
      reference_namespace: null,
      reference_version: null,
    });

    expect(unknown).toEqual({
      ...BASE_INPUT,
      taxon_id: null,
      organism: "unknown",
      feature_namespace: null,
      value_scale: "unknown",
      reference_namespace: null,
      reference_version: null,
    });
    expect(Object.isFrozen(unknown)).toBe(true);
    expect(expressionCompatibilityPartitionKey(unknown)).not.toBe(
      expressionCompatibilityPartitionKey(descriptor()),
    );
    expect(expressionCompatibilityPartitionKey(unknown)).not.toBe(
      expressionCompatibilityPartitionKey(
        descriptor({ taxon_id: null, organism: null, feature_namespace: null }),
      ),
    );
  });

  test("rejects missing, extra, blank, non-canonical, and non-string values", () => {
    const missing = { ...BASE_INPUT } as Record<string, unknown>;
    delete missing.expression_unit;
    expect(() => createExpressionCompatibilityPartitionDescriptor(missing)).toThrow(
      /expression_unit/,
    );
    expect(() =>
      createExpressionCompatibilityPartitionDescriptor({
        ...BASE_INPUT,
        binding_id: "binding_geo",
      }),
    ).toThrow(/binding_id/);
    expect(() =>
      createExpressionCompatibilityPartitionDescriptor({
        ...BASE_INPUT,
        schema_ref: " expression_gene.v2",
      }),
    ).toThrow(/schema_ref/);
    expect(() =>
      createExpressionCompatibilityPartitionDescriptor({
        ...BASE_INPUT,
        organism: "",
      }),
    ).toThrow(/organism/);
    expect(() =>
      createExpressionCompatibilityPartitionDescriptor({
        ...BASE_INPUT,
        taxon_id: 9606,
      }),
    ).toThrow(/taxon_id/);
    expect(() =>
      expressionCompatibilityPartitionKey({
        ...BASE_INPUT,
        value_scale: " log2",
      }),
    ).toThrow(/value_scale/);
    expect(() =>
      createExpressionCompatibilityPartitionDescriptor({
        ...BASE_INPUT,
        dataset_revision_id: "dsrev_geo_gse123_v1",
      }),
    ).toThrow(/dsrev_<lowercase sha256>/);
    expect(() =>
      createExpressionCompatibilityPartitionDescriptor({
        ...BASE_INPUT,
        organism: "Cafe\u0301",
      }),
    ).toThrow(/NFC-normalized/);
    const unexpected = {
      ...BASE_INPUT,
      unexpected: "binding-derived",
    };
    expect(() =>
      compareExpressionCompatibilityPartitions(descriptor(), unexpected),
    ).toThrow(/unexpected/);
  });

  test("key is independent of object property and source binding order", () => {
    const reversed = Object.fromEntries(
      Object.entries(BASE_INPUT).reverse(),
    );
    const reversedDescriptor = createExpressionCompatibilityPartitionDescriptor(reversed);

    expect(expressionCompatibilityPartitionKey(reversedDescriptor)).toBe(
      expressionCompatibilityPartitionKey(descriptor()),
    );
    expect(expressionCompatibilityMergeDomainKey(reversedDescriptor)).toBe(
      expressionCompatibilityMergeDomainKey(descriptor()),
    );

    const firstOrder = [descriptor(), descriptor({ expression_unit: "FPKM" })]
      .map(expressionCompatibilityPartitionKey)
      .sort();
    const secondOrder = [descriptor({ expression_unit: "FPKM" }), descriptor()]
      .map(expressionCompatibilityPartitionKey)
      .sort();
    expect(secondOrder).toEqual(firstOrder);
  });

  test("each semantic dimension deterministically splits the compatibility partition", () => {
    const changed: ReadonlyArray<
      readonly [keyof ExpressionCompatibilityPartitionInput, string | null]
    > = [
      ["schema_ref", "expression_probe.v2"],
      ["row_granularity", "probe_sample_measurement"],
      ["taxon_id", "NCBITaxon:10090"],
      ["organism", "Mus musculus"],
      ["feature_namespace", "geo_probe"],
      ["measurement_type", "probe_expression"],
      ["value_semantics", "raw_count"],
      ["value_scale", "log2"],
      ["expression_unit", "FPKM"],
      ["normalization_state", "raw"],
      ["reference_namespace", "Ensembl"],
      ["reference_version", "GRCh37"],
    ];

    const base = descriptor();
    for (const [dimension, value] of changed) {
      const other = descriptor({ [dimension]: value });
      const comparison = compareExpressionCompatibilityPartitions(base, other);
      expect(comparison, dimension).toEqual({
        semantic_compatible: false,
        same_merge_domain: false,
        differing_dimensions: [dimension],
      });
      expect(expressionCompatibilityPartitionKey(other), dimension).not.toBe(
        expressionCompatibilityPartitionKey(base),
      );
      expect(expressionCompatibilityMergeDomainKey(other), dimension).not.toBe(
        expressionCompatibilityMergeDomainKey(base),
      );
    }
  });

  test("identical semantic partitions share an integration path but revisions isolate merge collisions", () => {
    const firstRevision = descriptor();
    const secondRevision = descriptor({
      dataset_revision_id: `dsrev_${"b".repeat(64)}`,
    });

    expect(expressionCompatibilityPartitionKey(secondRevision)).toBe(
      expressionCompatibilityPartitionKey(firstRevision),
    );
    expect(expressionCompatibilityMergeDomainKey(secondRevision)).not.toBe(
      expressionCompatibilityMergeDomainKey(firstRevision),
    );
    expect(
      compareExpressionCompatibilityPartitions(firstRevision, secondRevision),
    ).toEqual({
      semantic_compatible: true,
      same_merge_domain: false,
      differing_dimensions: ["dataset_revision_id"],
    });
  });

  test("fully identical descriptors are the only members of one merge domain", () => {
    const first = descriptor();
    const second = descriptor();

    expect(compareExpressionCompatibilityPartitions(first, second)).toEqual({
      semantic_compatible: true,
      same_merge_domain: true,
      differing_dimensions: [],
    });
    expect(expressionCompatibilityMergeDomainKey(second)).toBe(
      expressionCompatibilityMergeDomainKey(first),
    );
  });
});
