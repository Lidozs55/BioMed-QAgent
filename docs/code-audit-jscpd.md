# jscpd 重复代码审计报告

**审计日期：** 2026-08-16  
**审计工具：** jscpd 5.0.15  
**审计目的：** 识别无意义的重复代码块，区分测试/协议样板等有意重复与生产代码中的可维护性风险。

## 结论

本轮没有发现可以直接判定为“无意义且应立即删除”的 P0/P1 重复代码。重复率主要由两类内容构成：

1. 测试夹具、断言和 WebSocket/HTTP 测试启动代码。它们在不同场景中重复，是为了保持测试隔离和让测试意图就地可读，不应仅因 jscpd 告警而合并。
2. 外部数据源适配器、Dataset adapter、权限状态分支和前端展示组件中的相似流程。它们大多具有真实的共同语义，但目前存在中等规模的维护性重复，后续可以按边界抽取共享 helper/基类。

因此建议将本报告中的候选项纳入后续重构队列，而不是进行机械式全局去重。对外部数据源和权限代码，优先保持显式分支与错误语义，再抽取无业务含义的 IO/格式化部分。

## 扫描方法

扫描使用 strict 模式，最小重复块为 **5 行 / 50 tokens**，格式覆盖 TypeScript、TSX、JavaScript 和 Python。依赖、构建产物、覆盖率、数据目录、缓存和快照文件被排除。

完整扫描命令：

```powershell
& 'C:\Program Files\nodejs\corepack.cmd' pnpm dlx jscpd frontend server packages database scripts `
  -p '**/*.{ts,tsx,js,jsx,py}' `
  -f typescript,tsx,javascript,jsx,python `
  -k 50 -l 5 --mode strict `
  --reporters console,json,markdown --output .tmp-jscpd `
  --ignore '**/node_modules/**,**/dist/**,**/coverage/**,**/.git/**,**/data/**,**/__pycache__/**,**/*.snap' `
  --no-colors --no-tips
```

为减少测试样板对结论的影响，另对生产源码进行了复核扫描：扫描 `frontend/src`、`server/src`、`packages/contracts/src` 和 `database/bridge.py`，并排除 `*.test.*`。

## 统计结果

| 范围 | 文件 | 代码行 | 克隆块 | 重复行 | 重复 token |
| --- | ---: | ---: | ---: | ---: | ---: |
| 全部源码（含测试） | 528 | 130,191 | 638 | 7,602（5.84%） | 51,938（6.54%） |
| 生产源码复核（排除测试） | 350 | 71,814 | 132 | 1,690（2.35%） | 10,342（2.58%） |

按语言的完整扫描结果：Python 2.36% 行重复，TSX 5.08%，TypeScript 6.17%，JavaScript 0%。这说明总重复率被 TypeScript 测试和场景化适配器显著抬高，不能直接等同于生产逻辑质量问题。

## 分类审计

### A. 有意重复，建议保留

- `server/tests/**`、`frontend/src/test/**`、`database/tests/**` 中的 fixture、断言和测试生命周期代码。典型重复是同一协议在不同输入/错误分支下的测试，合并后会降低测试可读性。
- `frontend/src/api/*.ts` 与 `frontend/src/api/types.ts` 的接口声明重复。这里更像 API 模块的局部契约镜像；若继续保留，应确保真正的 wire DTO 仍来自 `@biomed/contracts`，避免把 TypeScript interface 当作运行时校验。
- `server/src/runtime/controller.ts`、`reducers/stream.ts`、`runtime/transport.ts` 中的事件处理分支。相似结构对应不同事件类型或终态，不能只按文本相似度合并。
- `server/src/external/sources/*`、`server/src/agent/tools/*` 的来源适配器。请求、分页、响应解包常常相似，但 URL、字段映射、限流和错误语义不同，当前重复具有领域边界意义。

### B. 中等风险，建议后续抽取

这些克隆块不是当前缺陷，但修改时容易出现“一处修复、另一处遗漏”。

| 优先级 | 位置（jscpd 命中） | 规模 | 判断与建议 |
| --- | --- | ---: | --- |
| P2 | `frontend/src/components/BuildResultsViewer.tsx:39-61` ↔ `frontend/src/components/conversation/BuildReportCard.tsx:43-61` | 23 行 | Manifest summary 的 `JsonValue` 防御性 narrowing 重复。可抽到 `components/artifacts/manifestSummary.ts`，保持纯函数并配单测。 |
| P2 | `frontend/src/lib/apiResponseParsers.ts:262-279` ↔ `frontend/src/lib/eventParsersRuntime.ts:59-76` | 18 行 | 相同的 envelope/事件字段检查。建议共享 parser primitive；不要退回宽化 cast。 |
| P1 | `server/src/agent/tools/gdc.ts:42-122` ↔ `server/src/agent/tools/xena.ts:54-134` | 81 行 / 537 tokens | 两个数据源的查询、分页和结果整理流程高度相似。建议抽取“分页请求 + 行规范化”骨架，保留 source-specific query/field mapping。 |
| P1 | `server/src/dataset/adapters/adapters.ts:58-112` ↔ `server/src/dataset/adapters/geo/series-matrix.ts:89-144` | 55 行 / 261 tokens | Dataset adapter 的矩阵/列处理逻辑重复度高，且位于核心数据管线。建议先补行为等价测试，再抽取共享行列转换 helper。 |
| P1 | `server/src/external/sources/pubchem.ts:62-107` ↔ `server/src/external/sources/reactome.ts:64-109` | 42–46 行 / 200–218 tokens | 外部来源解析流程相似。建议抽取通用 HTTP/JSON 错误处理，保留每个来源的 schema 映射。 |
| P2 | `server/src/agent/permissions/broker.ts:282-306` ↔ `:385-409` | 25 行 / 129 tokens | grant/resolve 的状态收敛代码重复。权限代码属于安全边界，不建议立即合并；可先提取无副作用的 event/audit 构造函数并增加故障注入测试。 |

### C. 低风险、暂不处理

- `server/src/agent/tools/analysis.ts` 内多个统计工具的输入检查和结果包装。
- PDF、Publication、GEO 等模块中针对不同外部格式的相似解析步骤。
- 同一文件内的短块重复（通常 6–10 行），若没有共同变更原因，不足以抵消抽象层成本。

## 风险判断

当前真正需要关注的不是重复率本身，而是重复块是否拥有相同的变更原因：

- **相同变更原因：** 可抽取共享 helper，减少漂移风险。
- **不同变更原因但结构相似：** 保留显式代码，避免错误抽象掩盖来源/权限/协议差异。
- **测试代码：** 以场景可读性和失败定位为优先，不以 jscpd 数值为唯一标准。

本次 jscpd 结果没有证明存在行为不一致或安全漏洞；它只提供了候选位置。任何重构都应先添加/运行等价性测试，再进行抽取，并复跑 jscpd 与项目质量门禁。

## 后续建议

1. 将 `gdc.ts` / `xena.ts` 和 Dataset adapter 55 行克隆列为下一轮 P1 重构候选，先抽取纯函数，再处理网络副作用。
2. 将前端 manifest summary/parser narrowing 列为 P2，优先解决 wire-boundary 类型解析的重复与漂移。
3. 在 CI 中保留 jscpd 作为趋势指标，建议以“生产源码重复行百分比相对基线的变化”告警，不设置一次性全仓硬阈值。
4. 对权限 broker、发布/验证和事件持久化代码，禁止仅凭 jscpd 自动合并；必须经过状态机/错误语义审查。

## 限制

jscpd 是 token/文本级检测器，无法判断业务语义、错误处理差异或抽象是否会破坏架构边界。本报告因此把检测结果与源码职责结合审阅，结论是“未发现已确认的无意义重复；发现若干可维护性候选”，而不是把所有命中都视为缺陷。
