# BioMed-QAgent Backend

生物医学数据检索、下载、整理和呈现系统 — 基于 Qwen 与 OpenAI Agents SDK。

## 环境要求

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) 包管理器

## 安装

```bash
cd backend
uv sync
```

## 配置

复制 `.env.example` 为 `.env` 并填写 DashScope API Key：

```bash
cp .env.example .env
# 编辑 .env 设置 DASHSCOPE_API_KEY
```

关键配置项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DASHSCOPE_API_KEY` | (空) | DashScope API Key（必填） |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容端点 |
| `MODEL_NAME` | `qwen-plus` | Qwen 模型名 |
| `HOST` | `127.0.0.1` | 后端监听地址 |
| `PORT` | `8000` | 后端监听端口 |
| `OUTPUT_DIR` | `data/output` | 数据产物目录 |

## 启动

```bash
uv run uvicorn app.server:app --reload
```

启动后访问：
- API 文档 (Swagger): http://127.0.0.1:8000/docs
- API 文档 (ReDoc): http://127.0.0.1:8000/redoc

## 测试

```bash
uv run pytest                    # 运行全部测试
uv run pytest -v                 # 详细输出
uv run pytest tests/test_xxx.py  # 运行特定测试文件
```

## 项目结构

```
backend/
├── app/
│   ├── agent_loop/          # Agent loop 核心（agent, runner, context, model）
│   ├── api/                 # FastAPI 路由（WebSocket）
│   ├── domain/              # 领域模型（task, events, output, processing）
│   ├── skills/              # Skill 仓库（builtin + learned，四类）
│   │   ├── registry.py      # SkillRegistry + SkillDef
│   │   ├── builtin/         # 团队维护
│   │   └── learned/         # 自迭代生成
│   ├── tools/               # Function Tools
│   │   ├── _registry.py     # 工具注册中心
│   │   ├── io.py            # 文件读写
│   │   ├── search.py        # 文献检索（占位）
│   │   ├── parse.py         # PDF 解析（占位）
│   │   ├── analyze.py       # 数据分析（占位）
│   │   ├── workdir.py       # 任务工作目录
│   │   ├── processing.py    # 文件解析（CSV/TSV/JSON/HTML）
│   │   ├── cleaning.py      # 数据清洗
│   │   └── export.py        # CSV 导出
│   ├── config.py            # 配置
│   └── main.py              # FastAPI 入口
├── tests/                   # pytest 测试
├── pyproject.toml
└── uv.lock
```

## 技术栈

- **后端框架**: FastAPI + uvicorn
- **Agent SDK**: openai-agents-python
- **LLM**: Qwen (DashScope OpenAI 兼容接口)
- **数据模型**: pydantic v2 + dataclass
- **测试**: pytest + pytest-asyncio
