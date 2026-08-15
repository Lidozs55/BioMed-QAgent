# M07 测试矩阵

- Commit: be78a1a577a9d20cec4cefb3b604661f0187a59c
- 环境: Windows / Node 24.19

| Case | 结果 | 证据 |
| --- | --- | --- |
| M07-T01 | PASS | `dataset-compat-gate.test.ts`、`dataset-contracts.test.ts` |
| M07-T02 | PASS | `dataset-canonicalizer.test.ts`（MeasurementIdentity） |
| M07-T03 | PASS | `dataset-contracts.test.ts`（FieldMapping proposed） |
| M07-T04 | PASS | `ts-core-e2e.test.ts`（PARTIAL_SUCCESS 保留 rejected/provenance） |
| M07-T05 | PASS | `dataset-source-asset.test.ts`、`dataset-adapters.test.ts` |
| M07-T06 | PASS | `contracts.test.ts`（artifact roles 冻结） |
| M07-T07 | PASS | `dataset-publication.test.ts`（manifest assembly） |
| M07-T08 | PASS | `contracts.test.ts`（supersede）、`dataset-publication.test.ts` |
| M07-T09 | PASS | `dataset-runtime.test.ts`、`dataset-publication.test.ts`（digest） |
