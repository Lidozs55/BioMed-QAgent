# Runs Log

Concise log of non-obvious dataset-run outcomes and the decisions behind them.
`code says how; this file says why`. See `docs/ARCHITECTURE.md` for the system
reference.

## 2026-08-17 — gold2 probe-level re-drive (build_egfr_cetuximab_crc_1)

**Build**: `build_egfr_cetuximab_crc_1` · task
`task_ts_51bebe5b-800e-4ab9-bd90-b36214138cad`
**Sources**: GSE140973 + GSE236078 (Agilent 4x44k, GPL10332)
**Final run**: `run_ts_18325315` completed `2026-08-17T09:21:52Z`, `publish`
succeeded.

### Outcome

- `row_granularity: probe_sample_measurement`, `schema_ref:
  gene_expression.probe_long.v1`, primary key `[probe_id, platform_id,
  sample_id]`.
- `row_count = 6,540,765` = GSE140973 (5,072,430) + GSE236078 (1,468,335),
  merged via `append_by_canonical_row`, `conflict_count = 0`.
- Validation `gene_expression.probe_release.v1` → **passed** (10/10 checks;
  only warning-only Benford / last-digit anomalies on `value`).
- Probe→gene mapping shipped as audit reports
  `canonical/*_probe_mapping.csv` (44,495 rows per source, one per distinct
  probe).
- Manifest id `manifest_836b2f96d4856ab6` (sha256 `836b2f96…`); also held in
  `dataset_manifest.json`.

### Why probe-level release (not gene-level)

A gene-level build for GPL10332 is physically un-publishable: the platform has
6,798 features that cannot map to a gene (2,102 control spots, 2,412
ENSEMBL-only, 426 UNIGENE-only, 1 REFSEQ-only, 1,857 unannotated), so
gene-level `coverage == 1.0` is unreachable. Per design D4/D5 (see
`docs/archive/superpowers/specs/2026-08-08-phase5-geo-migration-design.md`),
that is expected, not a bug. The honest path that merges two sources and
publishes is **probe-level (D5 #2)**: every row keeps `geo_probe`
(namespace), and probe→gene mapping is recorded **only** in audit
(`normalization_log` + `probe_mapping.csv`), never promoted into primary rows.

### Two code fixes required

1. `server/src/dataset/canonicalizer/canonicalizer.ts` — the probe branch was
   implementing **D5 #4** semantics (mapped probes flipped to
   `gene_symbol`). Changed to **D5 #2**: under a probe schema a mapped row
   keeps `geo_probe`; the mapping target namespace is written only to the
   normalization log. Pinned by `server/tests/canonicalizer-parity.ts`.

2. `server/src/dataset/service/ts-core.ts` — the runner hardcoded
   `buildGeneExpressionSchema()` as the canonicalizer schema, so a probe spec
   still produced a gene-shaped CSV and every probe row carrying mapped
   targets surfaced as intra-source namespace mixing at
   `compatibility_gate` (`schema_mismatch; namespace_mismatch`). Now the
   schema is resolved from `spec.schema_ref` via the default registry, so a
   probe spec selects the probe schema and `probeSchema = true`.
   Regression-pinned by the probe-level E2E case in
   `server/tests/phase5/ts-core-e2e.test.ts` ("GEO probe-level spec resolves
   the probe schema via spec.schema_ref"): before the fix that spec produced a
   gene-column CSV and the gate rejected it with `schema_mismatch`.

### Footguns hit during the re-drive

- A redrive spec alone does **not** change a build's lineage: the parse op
  hardcodes its adapter output schema. To apply a new schema you must invalidate
  **both** `parse:*` and `canonicalize:*` checkpoints and their
  `state/*_output.json` files (script `_tmp_invalidate_gold2.mjs`).
- Server runs under `tsx watch`; source edits hot-reload, so a failing gate can
  change its `error` between attempts without a process restart.
- `validate_profile` may "succeed" while the profile **status** is `failed`
  (publish then refuses). Read `validation_report.json` / manifest
  `validation_summary.status`, not just the op status.
- **Tech-debt / caveat**: `canonicalize:*` `output_digest` (`09b57b0…`,
  `965f9084…`) is unchanged between the old gene-shaped and new probe-shaped
  outputs, so the digest appears not to cover the row columns. Untangle what the
  canonicalize digest actually covers and make it schema-sensitive.

### Obsolete artifacts to ignore

- `build_state.json` `operation_attempts` keeps every historical attempt
  (gate attempts 5–8 failed with `namespace_mismatch` / `schema_mismatch;`
  before the fixes; publish attempt 1 failed on the gene-level validation
  profile). `completed_operations` is the authoritative terminal set.

## 2026-08-17 — UTF-8 编码损坏红线（gold2 提交侧）

**根因与影响**：早期 `e2e-gold2-*` run 的中文 input 在提交侧损坏为 ASCII `?`
（`0x3F`）：task.json 标题出现 19 个问号，中文字符全被替换。agent 的英文思考链
因此只体现 "EGFR GEO 检索 / tumor-vs-normal / probe→gene"，**缺失 "肺腺癌/LUAD"
与 "EGFR 突变状态"**，实际把 LUAD EGFR 数据构建成了结直肠癌 cetuximab 耐药 PDX
队列（build_egfr_cetuximab_crc_1）——静默跑偏，无任何告警。

**两类损坏形态，分层拦截**：

1. 字节级损坏（解码产生 `U+FFFD`）：服务器 `readJsonBody` 用
   `Buffer.toString("utf8")` 把无效字节替换为 U+FFFD，服务器可可靠判定。
   - 加固：`task-repository.ts` 的 `createTask`/`createRun` 增加
     `requireCleanUtf8`，input 含 `\uFFFD` 即抛 `TypeError` → HTTP 422 + 可读
     detail（"read source files with 'utf8' … JSON.stringify"）。两条复现测试
     固定于 `durable-runtime.test.ts`。
2. 提交侧提前拦截 `0x3F` 形态（服务器无法可靠判别）：
   `scripts/run-driver.mjs` 对输入文件做字节级 `TextDecoder("utf-8",{fatal:true})`
   校验 + U+FFFD/lone-surrogate 检测，并对 Han 文本 + `????` 连用触发已知 gold2
   签名告警；提交统一走 `fs.readFileSync(path,"utf8")` + JSON POST。

**约定**：业务 input 一律用文件读取（显式 utf8 编码）提交，禁止在脚本里把中文
直接内联进字符串后再传输，避免再踩编码损坏陷阱。

**技术踩坑**：Node 24 中 `Buffer.isUtf8` 不存在，须用 `TextDecoder("utf-8",
{fatal:true})` 的 decode 抛出与否做字节校验。