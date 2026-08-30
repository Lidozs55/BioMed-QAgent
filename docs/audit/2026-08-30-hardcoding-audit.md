# 写死审查报告（hardcoding audit）— 2026-08-30

> 姊妹篇：[`2026-08-28-settings-wiring-audit.md`](2026-08-28-settings-wiring-audit.md)（设置接线审计）。本篇回答一个不同问题：**代码里哪些字面量该进设置系统而没进，哪些写死是必要的安全防护不能动。**
> 判据：安全防护/协议契约/来源事实知识 = 合法写死（挪走反而危险）；**模型身份、计费端点、容量上限、运行预算** = 必须可配置或至少与设置系统一致，静默生效的算缺陷。
> 状态：收集期，只登记不修。范围：`server/src`、`scripts/`、`frontend/src`（生产代码，测试 fixture 不计）。

## A 级 — 该接设置系统的写死（修复候选）

| # | 位置 | 写死内容 | 影响 | 修法方向 |
|---|------|---------|------|---------|
| A1 | `processing/vlm/vlm-client.ts:19` `VL_MODEL_NAME="qwen-vl-max"`；`settings/model-registry/model-resolution.ts:97` fallback；`chart-extraction.ts:212/382/538` | **VLM（图表抽取）模型完全在设置系统之外**：除非 active 模型 `capabilities.image=true`，永远打 qwen-vl-max。换模型对它无效、账单不出现在 active 模型上，与 B7 同族（身份写死+显示层不知情） | 高（图表 gold 案例的计费与可观测性黑洞） | settings 增加 vlm 模型槽（provider/model 二选一来源），`resolveVlmConfig` 读它；错误消息里的模型名改用解析值 |
| A2 | `vlm-client.ts:22` `DEFAULT_DASHSCOPE_BASE_URL` + `model-resolution.ts:96` env 链 | VLM base_url 不读 provider registry 的 base_url（仅 active-image 分支读）——provider 换自建/代理端点时 VLM 仍打公网 DashScope | 中（与 A1 同修） | VLM base_url 随其所属 provider 记录解析 |
| A3 | `agent/tools/gdc.ts:47`、`xena.ts:47`、`dataset/acquisition/expression-providers.ts:17-18` = 4 GiB | 下载上限与 `settings.runtime_limits.max_download_mib`（8 GiB）**双轨且更低**：设置放行 8GiB，代码在 4GiB 硬顶。方向安全但"设置说了不算" | 中（用户改设置无效） | 统一取 `min(provider cap, settings)` 或全部改读 runtime_limits |
| A4 | `store.ts:196/244` | DashScope base_url 字面量 ×2，未引用 `vlm-client.ts` 已有的同名共享常量 | 低（漂移隐患） | 引用单一常量；两处默认语义各自注释 |
| A5 | `pi-adapter.ts:545/562/710/844/867` | `contextWindow ?? 131_072` 兜底 ×5 分散 | 低（settings 恒有值时不触发，但改兜底要改 5 处） | 收敛 `DEFAULT_CONTEXT_WINDOW_FALLBACK` 单常量 + 注释"防御性兜底，非配置源" |
| A6 | 底层客户端超时/限速常量：`external/geo/client.ts:19-20`（60s/3 retry）、`ncbi/client.ts:98-99`、`publication/europe-pmc.ts:25`、`unpaywall.ts:23`、`browser/pool.ts:58`（导航 60s）、`crawler/rate-limit.ts:14` + `sources/fallback.ts:41`（2s）、`vlm-client.ts:28`（60s） | 与 `settings.runtime_limits`（http 300s / browser 300s / download 3600s / request_interval 500ms 均可配）**并存**。多数构造函数接受 options 覆盖，但覆盖是否从 runtime_limits 接线**逐个未证实**——browser 导航超时最可疑：设置 300s，pool 默认 60s | 中（设置改了不生效的"幽灵开关"，与 settings-wiring-audit 同病） | 逐个接线并加断言测试：改 settings → 生效；无覆盖需求的常量注释声明"非设置面" |
| A7 | `agent/tools/clinvar.ts:8`、`dbsnp.ts:8` 等工具层散落 source endpoint URL 常量 vs `dataset/acquisition/provider-catalog.ts` | 域名事实两轨存在（工具层各写各的），漂移风险（egress 白名单是第三道，安全但三处要人肉同步） | 低-中 | endpoint 单源化到 provider-catalog，工具层引用 |

## B 级 — 必要的安全防护/契约/知识（合法写死，禁止配置化）

明确**不要**把这些接进设置系统（给了开关等于给了绕过口）：

- **egress/SSRF 防线**：`url-policy.ts` 环视/私网拦截、`validateCredentialedPublicUrl`、host→preset 推断（`service.ts:767-774`）
- **权限 fail-closed 面**：supervisor 固定解析器白名单（`parse*.js` 无参形式）、`SENSITIVE_KEY`/脱敏正则（event-adapter、supervisor `SECRET_KEY`）、protected-paths、workspace_exec 对 curl/wget/URL-bearing 的预拒绝
- **wire/协议上限**：`event-adapter` 4096/200/depth-3/20-items 截断、`transform-host/protocol.ts` 帧数值上限、`http/body.ts` 1MiB body 上限——DoS 护栏
- **供给链锚点**：`gold9-providers.ts` 官方导出物的**固定内容 digest**（45/20min 专项预算注释齐全——这是范本，不是坏味道）、`ENV_BOOTSTRAP_PROVIDER_ID/MODEL_ID` 固定幂等 id、`schema_version` 常量
- **来源事实知识表**：`model-catalog.ts`（各模型窗口/能力）、`catalog.ts` VENDORS 与 param-specs、GEO/NCBI/EPMC 官方端点本身（单源化见 A7，事实值没错）
- **兼容谓词**：`usesDashScopeQwen`/`rejectsSamplingOverrides`（按模型名前缀的方言判定——是 provider 怪癖知识，写死正确；改名风险在注释已标）
- **PI_\* 环境变量链**：env 是设置系统的合法引导源（上轮已移除其后的臆造默认）

## C 级 — 内部工程常数（保持现状，注释即可）

`skill-iteration MAX_CONTEXT_TASKS=30`、`disk-index DEFAULT_BATCH_SIZE=4096`、`pool SESSION_CLOSE 5s/SELECTOR 1.5s`、compaction 推导系数（MIN/MAX_KEEP_RATIO、SUMMARY_BUDGET_RATIO——ratios 已可配，系数是派生算法本体）、supervisor `DEFAULT_TIMEOUT_MS`（CLI 可覆盖）。

## 结论与去向

1. **真问题集中在 VLM 通道（A1/A2）**：与已出事的 B7 同构——模型身份写死 + 设置层不感知。gold789 图表案例上会直接表现为"计费对不上、换模型无效"。建议进分流清单高优先级。
2. **A3/A6 是"幽灵开关"家族**：settings 里字段存在但被代码常量封顶/旁路 → 与 settings-wiring-audit 剩余项合并处理，逐字段加"改设置必生效"的断言测试。
3. A4-A7 是收敛/单源化，低风险。
4. **B 级零改动**——本报告一半价值在于明确"这些不许动"。
5. 收集期纪律：全部只登记；分流修复等组员测完（与 model-blockers 同步）。
