"""阿里云百炼 DashScope 客户端 — OpenAI 兼容模式。

强制使用 DashScope 平台，API Key 从环境变量 DASHSCOPE_API_KEY 读取。
支持：文本对话、多模态识图、长文档理解、Function Calling、流式输出。
"""
from __future__ import annotations

import json
import os
import base64
import logging
from typing import Any

from openai import OpenAI

from app.config import (
    DASHSCOPE_API_KEY,
    DASHSCOPE_BASE_URL,
    MODEL_TEXT,
    MODEL_VISION,
    MODEL_LONG,
    MODEL_STRONG,
)

logger = logging.getLogger(__name__)


class DashScopeClient:
    """阿里云百炼 DashScope 客户端（OpenAI 兼容模式）。

    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    """

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or DASHSCOPE_API_KEY or os.getenv("DASHSCOPE_API_KEY", "")
        if not self.api_key:
            logger.warning("DASHSCOPE_API_KEY 未设置，LLM 调用将失败")
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=DASHSCOPE_BASE_URL,
        )

    # ---- 文本对话 ----
    def chat(
        self,
        messages: list[dict],
        model: str = MODEL_TEXT,
        tools: list[dict] | None = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        response_format: dict | None = None,
        enable_search: bool = False,
    ) -> str:
        """文本对话，返回 assistant 消息内容。"""
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            kwargs["tools"] = tools
        if response_format:
            kwargs["response_format"] = response_format
        if enable_search:
            kwargs["extra_body"] = {"enable_search": True}

        resp = self.client.chat.completions.create(**kwargs)
        return resp.choices[0].message.content or ""

    def chat_json(
        self,
        messages: list[dict],
        model: str = MODEL_TEXT,
        temperature: float = 0.3,
    ) -> dict:
        """对话并返回 JSON 对象。"""
        text = self.chat(
            messages,
            model=model,
            temperature=temperature,
            response_format={"type": "json_object"},
        )
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # 尝试提取 JSON 块
            import re
            m = re.search(r"```json\s*(.*?)\s*```", text, re.DOTALL)
            if m:
                return json.loads(m.group(1))
            # 尝试提取 { ... }
            m = re.search(r"\{.*\}", text, re.DOTALL)
            if m:
                return json.loads(m.group(0))
            logger.error("无法解析 LLM 返回的 JSON: %s", text[:200])
            return {}

    # ---- 多模态识图 ----
    def chat_vision(
        self,
        prompt: str,
        image_path: str | None = None,
        image_url: str | None = None,
        image_base64: str | None = None,
        model: str = MODEL_VISION,
        temperature: float = 0.01,
        max_tokens: int = 4096,
    ) -> str:
        """多模态对话：传入图片（本地路径/URL/base64），返回文本。

        用于图表数据提取、表格图片识别等。
        """
        content: list[dict] = []
        if image_path:
            content.append({
                "type": "image_url",
                "image_url": {"url": self._encode_image(image_path)},
            })
        elif image_url:
            content.append({
                "type": "image_url",
                "image_url": {"url": image_url},
            })
        elif image_base64:
            content.append({
                "type": "image_url",
                "image_url": {"url": image_base64},
            })
        content.append({"type": "text", "text": prompt})

        messages = [{"role": "user", "content": content}]
        resp = self.client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return resp.choices[0].message.content or ""

    def chat_vision_json(
        self,
        prompt: str,
        image_path: str | None = None,
        image_url: str | None = None,
        model: str = MODEL_VISION,
    ) -> dict:
        """多模态对话，返回 JSON。"""
        text = self.chat_vision(prompt, image_path=image_path,
                                  image_url=image_url, model=model)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            import re
            m = re.search(r"\{.*\}", text, re.DOTALL)
            if m:
                return json.loads(m.group(0))
            return {}

    # ---- 长文档理解 ----
    def chat_document(
        self,
        prompt: str,
        file_id: str,
        system_prompt: str = "你是一个专业的文档分析助手。",
        model: str = MODEL_LONG,
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> str:
        """长文档理解：传入百炼平台的 fileid，理解 PDF 全文。

        file_id 通过上传文件到百炼平台获取。
        """
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "system", "content": f"fileid://{file_id}"},
            {"role": "user", "content": prompt},
        ]
        resp = self.client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return resp.choices[0].message.content or ""

    # ---- 流式输出 ----
    def chat_stream(
        self,
        messages: list[dict],
        model: str = MODEL_TEXT,
        temperature: float = 0.7,
    ):
        """流式对话，yield 每个 chunk 的文本。"""
        stream = self.client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            stream=True,
        )
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

    # ---- 辅助 ----
    @staticmethod
    def _encode_image(path: str) -> str:
        """读取本地图片并编码为 base64 data URL。"""
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        mime = {"png": "png", "jpg": "jpeg", "jpeg": "jpeg",
                "webp": "webp", "bmp": "bmp", "gif": "gif"}.get(ext, "png")
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return f"data:image/{mime};base64,{b64}"

    def is_available(self) -> bool:
        """检查 API Key 是否配置。"""
        return bool(self.api_key)
