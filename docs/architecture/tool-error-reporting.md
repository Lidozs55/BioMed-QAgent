# 工具报错语义化（Agent 可自纠错错误面）

> 主题文件：工具层如何把失败返回给主 Agent（Pi），使模型能区分
> 「我参数传错了」「上游暂时挂了」「宿主代码有 bug」并据此调整下一次调用。
> 代码入口：`server/src/agent/tools/result.ts`、
> `server/src/agent/tools/schema-validation.ts`、
> `server/src/external/network/errors.ts`（`ToolHttpError`）。

## 三类失败，三种信号

工具失败统一经 `errorResult()` 序列化为结构化 JSON：

```json
{
  "error": "<一句话摘要，≤2000 字符>",
  "code": "invalid_arguments | upstream_http_error | tool_error",
  "retryable": false,
  "status_code": 429,
  "detail": [{ "loc": ["query"], "msg": "Field required", "type": "missing", "input": "…" }],
  "stack": ["at … (server/src/…:123:9)"]
}
```

| 字段 | 出现条件 | 含义 |
| --- | --- | --- |
| `detail` | 参数未通过 schema 校验（FastAPI 422 风格，`loc/msg/type/input` 字段级问题列表，≤20 条，input 截断 200 字符） | Agent 改参数即可恢复；`code=invalid_arguments`、`retryable=false` |
| `status_code` + `retryable` | 抛出 `ToolHttpError` | 429/5xx → `retryable=true`；4xx → 参数或路径问题 |
| `stack` | Error 带第一方帧时 | 只保留 `server/src/`、`packages/` 帧、≤8 帧；Agent 可配合 `read_dataset_core_source` 等读源码工具定位宿主 bug |

## 关键设计决策

- **集中式 schema 校验而非逐工具手写**：`toPiCustomTools` 的 execute 包装
  （`server/src/agent/pi-adapter.ts`）在调用 `tool.execute` 前用
  `validateToolArgumentsOrThrow` 按工具声明的 JSON-Schema 校验参数，
  全部工具一次受益。校验器是手写的最小子集实现
  （type/properties/required/additionalProperties/enum/items/anyOf +
  minLength/minItems/minimum/pattern），**有意不引 ajv** —— 工具目录只用到
  这个封闭子集（依赖纪律）。
- **`format` 关键字有意不校验**（宽松处理），避免误伤合法输入。
- **ToolHttpError 靠鸭子类型进入 errorResult**（`code`/`retryable`/`statusCode`
  属性而非 instanceof），各工具无需 import 序列化层。
- **响应体摘录（bodyExcerpt）支持但当前未采集**：GDC/clinvar/openfda 的
  失败路径在错误前 `response.discard()`；读取摘录需要改动下载预算，收益
  有限，留待真实需求出现。
- `detail.input`、`stack`、`error` 都有截断上限，防止错误面撑爆 Agent 上下文。
