"""全链校验脚本：AST + import 链 + 工具数 + skills 数。"""
import ast, os, sys, importlib, traceback

ROOT = os.path.join(os.path.dirname(__file__), "backend")
sys.path.insert(0, ROOT)

errs = []

# 1. AST 校验所有 .py
for r, _, fs in os.walk(os.path.join(ROOT, "app")):
    for f in fs:
        if f.endswith(".py"):
            p = os.path.join(r, f)
            try:
                ast.parse(open(p, encoding="utf-8").read(), filename=p)
            except SyntaxError as e:
                errs.append(f"AST ERR {p}: {e}")

print(f"[1] AST 校验：{sum(1 for _,_,fs in os.walk(os.path.join(ROOT,'app')) for f in fs if f.endswith('.py'))} 个 .py 文件，错误 {len(errs)}")
for e in errs:
    print("   ", e)

# 2. import 链校验（关键模块）
modules = [
    "app.main",
    "app.config",
    "app.agents.orchestrator",
    "app.agents.registry",
    "app.agents.search",
    "app.agents.acquire",
    "app.agents.parser",
    "app.agents.cleaner",
    "app.agents.analysis",
    "app.agents.reviewer",
    "app.agents.llm_reporter",
    "app.tools.registry",
    "app.tools.browser_agent",
    "app.api.routes.tasks",
    "app.api.routes.data",
    "app.api.routes.lineage",
    "app.api.routes.ws",
    "app.api.routes.feedback",
    "app.models.task",
    "app.provenance.tracker",
    "app.storage.task_store",
]
imp_errs = []
for m in modules:
    try:
        importlib.import_module(m)
    except Exception as e:
        imp_errs.append(f"{m}: {e}")
        traceback.print_exc()

print(f"[2] import 链校验：{len(modules)} 模块，错误 {len(imp_errs)}")
for e in imp_errs:
    print("   ", e)

# 3. 工具数 + skills 数
try:
    from app.tools.registry import ToolRegistry
    tr = ToolRegistry()
    tool_methods = [m for m in dir(tr) if not m.startswith("_") and callable(getattr(tr, m)) and not m.startswith("run_datasource")]
    print(f"[3] ToolRegistry 实例化 OK，公开方法 {len(tool_methods)} 个")
except Exception as e:
    print(f"[3] ToolRegistry 实例化失败: {e}")
    traceback.print_exc()

try:
    from app.agents.registry import AgentRegistry, register_all_agents
    register_all_agents()
    agents = list(AgentRegistry._agents.keys())
    print(f"[4] AgentRegistry 注册 {len(agents)} 个 Agent: {agents}")
except Exception as e:
    print(f"[4] AgentRegistry 失败: {e}")
    traceback.print_exc()

# 5. FastAPI app 路由数
try:
    from app.main import app
    routes = [r for r in app.routes if hasattr(r, "methods")]
    print(f"[5] FastAPI app 路由数：{len(routes)}")
    # 关键端点
    paths = [getattr(r, "path", "") for r in app.routes]
    for key in ["/api/v1/health", "/api/v1/tasks", "/api/v1/skills"]:
        match = [p for p in paths if p.startswith(key)]
        print(f"   {key}: {match[:3]}")
except Exception as e:
    print(f"[5] FastAPI app 加载失败: {e}")
    traceback.print_exc()

# 6. browser_agent 关键函数
try:
    from app.tools.browser_agent import is_js_heavy_source, crawl_with_browser
    print(f"[6] browser_agent: is_js_heavy_source('cnki')={is_js_heavy_source('cnki')}, crawl_with_browser 可调用={callable(crawl_with_browser)}")
except Exception as e:
    print(f"[6] browser_agent 校验失败: {e}")

# 7. orchestrator 关键方法
try:
    from app.agents.orchestrator import Orchestrator
    methods = ["run", "run_resume", "run_export", "_needs_confirmation", "_build_checkpoint_payload", "_load_context"]
    missing = [m for m in methods if not hasattr(Orchestrator, m)]
    print(f"[7] Orchestrator 关键方法校验：缺失 {missing}")
except Exception as e:
    print(f"[7] Orchestrator 校验失败: {e}")

total_err = len(errs) + len(imp_errs)
print(f"\n=== 总错误数：{total_err} ===")
sys.exit(0 if total_err == 0 else 1)
