"""图表数据提取（本地图片识别，调用 Qwen-VL API）。

用途：从本地图表图片中识别图表类型并提取数据点，返回结构化 JSON。
输入：本地图片路径（png/jpg/jpeg/webp/bmp/gif）
输出：{chart_type, axes:{x:{label,values},y:{label,values}}, data_points, legend}

依赖环境变量 QWEN_API_KEY（或 DASHSCOPE_API_KEY）；调用 DashScope 兼容模式 API（qwen-vl-max）。
调度器内置不支持本地图片识别，本模块是 skill 中唯一处理本地图片的工具。

模块导入示例：
    from .extract_chart_data import extract_chart_data

    result = extract_chart_data("chart.png", output_path="chart_data.json")
    # result = {"status":"ok", "chart_type":"bar", "axes":{...}, "data_points":[...], "legend":[...]}
"""
import base64
import json
import os
import urllib.error
import urllib.request

API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = "qwen-vl-max"

# 提示词：要求模型识别图表类型、提取数据点、返回严格 JSON
PROMPT = (
    "请识别这张图表并提取数据。返回严格 JSON 格式（不要 markdown 代码块）：\n"
    "{\n"
    '  "chart_type": "bar|line|scatter|pie|heatmap|volcano|bubble|box",\n'
    '  "axes": {"x": {"label": "", "values": []}, "y": {"label": "", "values": []}},\n'
    '  "data_points": [{"x": "", "y": "", "label": ""}],\n'
    '  "legend": []\n'
    "}\n"
    "注意：data_points 为图中所有可见数据点；如无法识别某字段填 null。"
)


def _encode_image(path):
    """读取图片并编码为 base64 data URL。"""
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    mime = {"png": "png", "jpg": "jpeg", "jpeg": "jpeg",
            "webp": "webp", "bmp": "bmp", "gif": "gif"}.get(ext, "png")
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:image/{mime};base64,{b64}"


def _call_qwen(api_key, image_url):
    """调用 Qwen-VL API，返回模型输出文本。"""
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": image_url}},
            {"type": "text", "text": PROMPT},
        ]}],
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body["choices"][0]["message"]["content"]


def extract_chart_data(image_path, output_path=None):
    """从本地图片提取图表数据（调用 Qwen-VL API）。

    Args:
        image_path: 本地图片路径（png/jpg/jpeg/webp/bmp/gif）
        output_path: 输出 JSON 路径，省略则不写文件（仅返回 dict）

    Returns:
        dict: {"status":"ok", "chart_type":..., "axes":..., "data_points":[...], "legend":[...]}

    Raises:
        RuntimeError: 未设置 QWEN_API_KEY 环境变量
        FileNotFoundError: 图片文件不存在
        urllib.error.URLError: 调用 Qwen-VL API 网络错误
        Exception: 图片读取/编码失败或调用 API 失败
    """
    api_key = os.environ.get("QWEN_API_KEY") or os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError("未设置 QWEN_API_KEY 环境变量，无法调用 Qwen-VL API")
    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"图片文件不存在: {image_path}")

    image_url = _encode_image(image_path)
    text = _call_qwen(api_key, image_url)

    # 解析模型返回的 JSON（去除可能的 markdown 代码块）
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        result = {"chart_type": "unknown", "axes": None,
                  "data_points": [], "legend": [], "raw": text}

    payload = {
        "status": "ok",
        "chart_type": result.get("chart_type", "unknown"),
        "axes": result.get("axes"),
        "data_points": result.get("data_points", []),
        "legend": result.get("legend", []),
    }
    if output_path:
        out_dir = os.path.dirname(os.path.abspath(output_path))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False, indent=2))
    return payload
