export interface SettingsIndexEntry {
  id: string;
  title: string;
  keywords: string[];
  section: string;
  anchor: string;
}

/**
 * Single source of truth for global settings search. Every searchable
 * SettingRow should be registered here so the sidebar search can find it.
 */
export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  {
    id: "model.vendor",
    title: "服务商",
    keywords: ["vendor", "供应商", "dashscope", "openai", "deepseek", "base url"],
    section: "model",
    anchor: "settings-vendor",
  },
  {
    id: "model.base-url",
    title: "Base URL",
    keywords: ["api 地址", "endpoint", "接口地址", "模型服务"],
    section: "model",
    anchor: "settings-baseurl",
  },
  {
    id: "model.api-key",
    title: "API Key",
    keywords: ["密钥", "apikey", "token", "认证", "凭证"],
    section: "model",
    anchor: "settings-apikey",
  },
  {
    id: "model.name",
    title: "模型",
    keywords: ["model", "模型名称", "qwen", "选择模型"],
    section: "model",
    anchor: "settings-model",
  },
  {
    id: "model.max-tokens",
    title: "最大输出 Tokens",
    keywords: ["max tokens", "输出长度", "生成长度", "tokens"],
    section: "model",
    anchor: "settings-maxtokens",
  },
  {
    id: "model.temperature",
    title: "Temperature",
    keywords: ["温度", "随机性", "生成参数", "创意"],
    section: "model",
    anchor: "settings-temperature",
  },
  {
    id: "model.top-p",
    title: "Top P",
    keywords: ["核采样", "采样", "生成参数", "top_p"],
    section: "model",
    anchor: "settings-topp",
  },
  {
    id: "model.search",
    title: "联网搜索",
    keywords: ["web search", "搜索", "联网", "工具"],
    section: "model",
    anchor: "settings-search",
  },
  {
    id: "model.thinking",
    title: "思维链模式",
    keywords: ["thinking", "推理", "深度思考", "qwq"],
    section: "model",
    anchor: "settings-thinking",
  },
  {
    id: "databases.upload",
    title: "上传数据库",
    keywords: ["import", "导入", "数据库包", "json", "yaml", "zip"],
    section: "databases",
    anchor: "settings-database-upload",
  },
  {
    id: "databases.new",
    title: "新建数据库",
    keywords: ["create", "新增", "声明式", "declarative"],
    section: "databases",
    anchor: "settings-database-new",
  },
  {
    id: "appearance.theme",
    title: "主题模式",
    keywords: ["theme", "深色", "浅色", "系统", "外观"],
    section: "appearance",
    anchor: "settings-theme-mode",
  },
  {
    id: "appearance.accent",
    title: "强调色",
    keywords: ["accent", "主色", "色板", "颜色", "primary"],
    section: "appearance",
    anchor: "settings-accent",
  },
  {
    id: "appearance.font",
    title: "界面字体",
    keywords: ["font", "字体", "typography", "排版"],
    section: "appearance",
    anchor: "settings-font",
  },
  {
    id: "appearance.font-import",
    title: "导入字体",
    keywords: ["import font", "字体文件", "ttf", "otf", "woff", "woff2"],
    section: "appearance",
    anchor: "settings-font-import",
  },
  {
    id: "appearance.light-background",
    title: "浅色主题背景",
    keywords: ["背景色", "background", "颜色", "浅色"],
    section: "appearance",
    anchor: "settings-light-background",
  },
  {
    id: "appearance.dark-background",
    title: "深色主题背景",
    keywords: ["背景色", "background", "颜色", "深色"],
    section: "appearance",
    anchor: "settings-dark-background",
  },
  {
    id: "appearance.sidebar",
    title: "半透明侧边栏",
    keywords: ["sidebar", "侧边栏", "毛玻璃", "半透明", "blur"],
    section: "appearance",
    anchor: "settings-translucent-sidebar",
  },
  {
    id: "appearance.contrast",
    title: "对比度",
    keywords: ["contrast", "对比", "可读性"],
    section: "appearance",
    anchor: "settings-contrast",
  },
  {
    id: "appearance.pointer-cursor",
    title: "使用指针光标",
    keywords: ["光标", "cursor", "指针", "悬停"],
    section: "appearance",
    anchor: "settings-pointer-cursor",
  },
  {
    id: "appearance.reduced-motion",
    title: "减少动态效果",
    keywords: ["动画", "动效", "motion", "reduced", "过渡"],
    section: "appearance",
    anchor: "settings-reduced-motion",
  },
  {
    id: "appearance.ui-font-size",
    title: "UI 字号",
    keywords: ["字号", "字体大小", "font size", "缩放"],
    section: "appearance",
    anchor: "settings-ui-font-size",
  },
  {
    id: "editor.send-shortcut",
    title: "发送快捷键",
    keywords: ["enter", "快捷键", "换行", "发送", "shortcut"],
    section: "editor",
    anchor: "settings-send-shortcut",
  },
  {
    id: "editor.follow-up-mode",
    title: "跟进处理方式",
    keywords: ["队列", "排队", "调整方向", "引导", "steer", "queue", "跟进"],
    section: "editor",
    anchor: "settings-follow-up-mode",
  },
  {
    id: "editor.context-usage",
    title: "显示上下文窗口使用情况",
    keywords: ["上下文", "context", "用量", "tokens", "指示器"],
    section: "editor",
    anchor: "settings-context-usage",
  },
  {
    id: "personalization.custom-instructions",
    title: "自定义指令",
    keywords: ["指令", "instructions", "提示词", "system prompt", "个性化"],
    section: "personalization",
    anchor: "settings-custom-instructions",
  },
  {
    id: "personalization.personality",
    title: "个性",
    keywords: ["语气", "个性", "personality", "tone", "回复风格"],
    section: "personalization",
    anchor: "settings-personality",
  },
  {
    id: "general.export",
    title: "导出本地缓存",
    keywords: ["export", "导出", "缓存", "zip", "备份"],
    section: "general",
    anchor: "settings-export-cache",
  },
  {
    id: "runtime.command-timeout",
    title: "命令执行超时",
    keywords: ["runtime", "运行限制", "timeout", "超时", "命令", "秒"],
    section: "runtime-limits",
    anchor: "runtime-limit-command_timeout_seconds",
  },
  {
    id: "runtime.download-size",
    title: "单文件下载大小",
    keywords: ["download", "下载", "大小", "文件", "gdc"],
    section: "runtime-limits",
    anchor: "runtime-limit-max_download_mib",
  },
  {
    id: "runtime.dataset-timeout",
    title: "数据集操作超时",
    keywords: ["dataset", "数据集", "构建", "解析", "超时"],
    section: "runtime-limits",
    anchor: "runtime-limit-dataset_operation_timeout_seconds",
  },
];

function scoreEntry(entry: SettingsIndexEntry, query: string): number {
  const haystack = [entry.title, ...entry.keywords]
    .join(" ")
    .toLowerCase();
  if (haystack === query) return 100;
  if (haystack.startsWith(query)) return 80;
  if (haystack.includes(query)) return 60;
  return 0;
}

export function searchSettingsIndex(query: string, limit = 8): SettingsIndexEntry[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [];
  return SETTINGS_INDEX.map((entry) => ({ entry, score: scoreEntry(entry, normalized) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entry);
}
