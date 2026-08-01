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
    id: "skills.filter",
    title: "筛选技能",
    keywords: ["filter", "搜索技能", "过滤"],
    section: "skills",
    anchor: "settings-skill-filter",
  },
  {
    id: "skills.install",
    title: "安装技能",
    keywords: ["install", "上传", "导入技能", "validate", "安装"],
    section: "skills",
    anchor: "settings-skill-install",
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
    id: "general.export",
    title: "导出本地缓存",
    keywords: ["export", "导出", "缓存", "zip", "备份"],
    section: "general",
    anchor: "settings-export-cache",
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
