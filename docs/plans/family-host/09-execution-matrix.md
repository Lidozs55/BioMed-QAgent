# Family Host 改造执行矩阵

## 1. 工作包总览

| ID | 工作包 | 主要产物 | 可并行起点 | 硬依赖 | 不可宣称 |
|---|---|---|---|---|---|
| P0 | Gold evidence closure | same-commit 诊断/修复证据 | 立即 | 当前 evaluator | 不能以历史 evidence 代替 |
| A | Contract/Projection/Identity | versioned schema/table/relation/identity | 立即 | 无 | 不能宣称 Agent 已支持任意 schema set |
| B | Streaming primitives | bounded reader/writer/store/result | 立即 | 可先用现有 expression contract | 不能宣称 generic runtime production-ready |
| C | Same-Schema Integration | table-owned identity/dedup/conflict/provenance | A1+B3 后 | A/B | 不能用 append 或顺序 winner |
| D-GEO | GEO projection | expression vertical slice | A2+B2 后 | A/B | 不能宣称整族 activation |
| D-GDC | GDC projection | shared gene/sample/dataset path | A2+B2 后 | A/B | 不能独立定义 identity |
| D-Xena | Xena projection | shared gene/sample/dataset path | A2+B2 后 | A/B | 不能独立定义 identity |
| E | Validation/provenance/assessment | semantic gate + actual closure | A/C/B4 后 | A/B/C/D | 不能只靠 B3 |
| F | Family Registry/Host | package loader/resolver/scope/version | A/B/E 初步稳定后 | A/B/E + compatibility | 不能绕过 Core admission |
| G | Agent interface | discovery/proposal/task Family | F2/F4 后 | F + versioned contracts | 不能暴露未支持 wire shape |
| H | Publication/evaluator/release | activation gates/Gold rerun | P0/E/D 后 | 全部相关链路 | 不能以 tool/build success 代替 product success |

## 2. 推荐批次

### Batch 0：当前收敛与契约冻结

并行：P0、A1、B1、E1 fixture。

出口：Gold dominant blockers 已知；projection identity 草案可 parse；bounded reader/writer API 草案；ProductAssessment generic fixture green。

### Batch 1：可信 expression 前置能力

并行：A2/A3、B2/B3、C1/C2、D-GEO adapter design、E2。

出口：gene/probe projection、table identity、disk-backed state、committed result、merge contract fixture 均稳定。

### Batch 2：GEO trusted vertical slice 与 provider 并行

主线：D-GEO + C3 + E3/E4 + H1。

并行支线：D-GDC、D-Xena 各自 adapter/projection/fixture；F1/F2 loader 只做 fixture/离线，不接 production Registry。

出口：GEO 能完成 task/run/build/trusted inputs/operation results/validation/assessment/publication/artifact hash parity；GDC/Xena 至少具备 shared contract 级验证。

### Batch 3：跨 source 与 family activation

并行：D-GDC、D-Xena、C5、B5/B6、E5、H2/H3。

出口：GEO+GDC 或 GEO+Xena 跨 source integration 具备 deterministic conflict/provenance；所有相关 capability 的状态可审计；Gold1 同 commit rerun 条件明确。

### Batch 4：Generic primitive 与 Family Host 前置

并行：C generic extraction、E generic table policy、F3/F4、G0/G1。

出口：至少两个真实消费者使用同一 integration/validation primitive；resolver 输出可执行且 fail-closed；旧 Registry/manifest/publication compatibility 通过。

### Batch 5：动态 Family Host 与 Agent task proposal

顺序：F5 -> G2 -> G3 -> H capability-level activation。

出口：task-scoped declarative Family 能在 Core admission 后执行；任意代码、workspace bypass、未注册 receipt、直接 publish 均失败；promotion 需显式审批。

## 3. 分支与交接建议

- A：`feat/family-host-contracts`；对 `packages/contracts`、Schema、manifest/parser 负责。
- B/C：`feat/family-host-streaming-integration`；对 integrator/store/writer/result 负责，可在 A API 稳定后 rebase。
- D-GEO/GDC/Xena：分别独立分支，避免 provider 文件并发冲突；只消费 A/B/C 公共接口。
- E：`feat/family-host-product-gate`；先 contracts/fixtures，后 runtime wiring。
- F/G：必须等 parser/resolver API review 后开分支；禁止在 Agent tool schema 中先行伪造能力。
- H/P0：保持 evaluator 与生产 runtime 分支隔离；Gold 资料不得进入 production family registry。

每个分支合并前提供：变更文件清单、契约版本、依赖/implementation digest、测试命令和明确的“声明 capability / trusted E2E / production activated”状态。

## 4. 合并顺序

1. P0 当前 Gold diagnostic/evidence closure；
2. A contract/projection/identity；
3. B streaming primitives；
4. C integration；
5. D-GEO internal trusted vertical slice；
6. E semantic/provenance/assessment；
7. D-GDC/D-Xena cross-source；
8. H publication/evaluator same-commit rerun；
9. F Registry Host；
10. G Agent dynamic proposal；
11. capability-level activation 和 release hardening。

F/G 可以在 Batch 2 做离线 prototype，但不得提前改变默认 production topology。

## 5. DoD 模板

每个工作包必须填写：

- Scope：实现了哪些 capability，明确未实现哪些；
- Contract：版本、parser、digest、compatibility；
- Trust：输入/输出是否 Core-owned，receipt/provenance 是否闭合；
- Resource：RSS/heap/temp/quota/cancel/timeout/restart；
- Tests：unit、fixture、regression、E2E；
- Evidence：task/run/build/publication/artifact refs；
- Activation：`declared` / `fixture_verified` / `trusted_e2e_verified` / `production_activated`；
- Rollback：旧路径如何保留、如何关闭新路径；
- Documentation：架构/ADR/TODO 是否同步。

## 6. 关键阻塞判断

以下任一条件成立时，暂停 Family Host 动态化，继续做收敛或补证：

- Gold evaluator 仍不能定位主要 failure boundary；
- expression production 需要完整读入内存；
- provenance coverage 仍是硬编码；
- publication 只依赖 workspace/sidecar；
- ProductAssessment 与 Publication identity 不一致；
- task Family 可携带任意 executable extension；
- 新抽象只有一个 benchmark consumer；
- `DatasetBuildSpec` wire 变化没有进入 `@biomed/contracts` 版本化解析。
