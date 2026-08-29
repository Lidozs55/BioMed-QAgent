# HIL 审批档位与大模型初审 (hil-approval-policy)

> 三档审批权限分配(人工审批 / 大模型初审 / 不审批)与大模型初审环节的
> 行为、配置与不变量。功能入口:设置 → Agent → "HIL 审批"。

## 1. 动机与语义

经典 HIL 是纯文字人工审批:每个 blocking 请求暂停 Run,等待用户在批量审核
卡片上做决定。本策略在 HIL 请求创建之后、暂停等待人工之前引入一个可配置的
**审批档位(approval mode)**,共三档:

| 档位 | 枚举值 | 行为 | reviewer 记录 |
| --- | --- | --- | --- |
| 人工审批 | `human_review` | 现状行为:请求 pending,暂停 Run 等待人工决定 | `user` |
| 大模型初审 | `llm_pre_review` | 大模型先审;初审**通过**则立即按该 kind 的肯定决定自动解决(并记录理由),**不通过 / 调用失败 / 输出不可解析**时回退人工审批(fail-safe) | `model` |
| 不审批 | `auto_approve` | 请求创建后立即按肯定决定解决,完全不暂停 | `auto` |

肯定决定按 kind 区分:`permission` → `{action:"approve"}`;审核类 →
`{action:"accept"}`。`HumanReviewRecord.reviewer` 由单一 `"user"` 扩展为
`"user" | "model" | "auto"`(`packages/contracts/src/hil.ts`),保证所有自动
解决在审计链上可分辨。

关键点:**只有模型审批不通过的请求才进入人工审批**;自动解决不发出
`user_input_required` 事件,Run 不暂停,而是追加一条
`HIL_PRE_APPROVED:<request_id>` warning 事件供时间线观测。

## 2. 按范围(scope)分配

配置持久化在 `data/settings/hil-approval.json`,REST 面为:

```text
GET /api/v1/settings/hil-approval
PUT /api/v1/settings/hil-approval   { default_mode?, review_modes? }
```

- `default_mode`:未单独分配的 scope 的兜底档位(默认 `human_review`)。
- `review_modes`:按 scope 覆盖;scope 为 `"permission"` 加全部
  `HILReviewType`;`null` 值清除覆盖回 default。
- 档位读取发生在每次 `requestHIL` 时(共享同一 store 实例),修改即时生效,
  不影响已创建的请求。

### 人工强制 scope(不可改档)

三个发布信任边界的 scope 固定人工审批,设置 API 对非人工档位返回 422:

- `vlm_extraction` — bioactivity chart 证据组装门禁要求 `reviewer === "user"`。
- `browser_evidence_acceptance` — 浏览器发布交接链按 `reviewer: "user"` 契约。
- `publication_acceptance` — `parseProductAssessment` 的
  `human_review_evidence` 只接受 `reviewer: "user"`。

这与 `docs/TODO.md` 中"极低风险正式化免人审路径(待产品决策,先 `[Q]`)"一致:
自动档不绕过发布边界。

## 3. 大模型初审客户端

`server/src/runtime/hil-pre-review.ts`:

- `createHilModelReviewer(resolveModel)` — OpenAI 兼容
  `POST {baseUrl}/chat/completions`(复用活动会话模型配置 + `PublicHttpClient`
  URL 策略,60s 超时,temperature 0)。输入为请求的 review_items JSON;输出要求
  严格 `{"verdict":"pass"|"fail","reason":"…"}`,`parseVerdict` 做容错解析
  (剥离代码围栏、裁剪 reason 到 500 字符)。
- 任何错误(HTTP 非 2xx、非 JSON、verdict 非法、无模型可用)一律视为
  `fail` → 回退人工审批;**自动档宁可不生效,也不放行未经确认的请求**。

## 4. 接入点

```text
DurableHILGate.requestHIL (server/src/runtime/hil-gate.ts)
  ├─ 创建 request(store,幂等)
  ├─ tryPreReviewResolve
  │    ├─ modeFor(kind, review_type)          ← JsonHilApprovalPolicyStore
  │    ├─ auto_approve → store.resolveRequest(reviewer:"auto")
  │    ├─ llm_pre_review → modelReview(request)
  │    │    ├─ pass   → store.resolveRequest(reviewer:"model")
  │    │    └─ fail/异常 → 落入下方人工流程
  │    └─ human_review → 直接人工流程
  └─ 人工流程:发 user_input_required → 暂停 → resume/continuation(不变)
```

确定性续跑(execution continuation)天然兼容:已自动解决的请求在重放时由
store 幂等返回既有 review,与人工决定走同一条路径。

## 5. 已知边界(文档化的行为,非缺陷)

- `unit_conversion` 的肯定决定是 `accept`,而该审核**结构性需要结构化修正**
  (`parseUnitCorrection`)。因此"不审批"档会让该操作显式失败
  ("unknown units require a structured correction");大模型初审对
  `proposed_value: null` 的项应判 fail(提示词已含该规则)。设置界面已提示
  该范围建议保持人工审批或大模型初审。
- advisory(非 blocking)HIL 与 credential `request()` 之外的许可流不经过
  本策略;`recordAdvisoryHIL` 保持原样。
- 档位不属于 evidence digest 输入,修改档位不会使已持久化请求失效。
