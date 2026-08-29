import {
  type LucideIcon,
  Cpu,
  Database,
  Keyboard,
  ListChecks,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Timer,
} from "lucide-react";

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

export interface SettingsNavGroup {
  id: string;
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    id: "personal",
    label: "个人",
    items: [
      { id: "general", label: "常规", icon: SlidersHorizontal },
      { id: "personalization", label: "个性化", icon: Sparkles },
    ],
  },
  {
    id: "interface",
    label: "界面",
    items: [
      { id: "editor", label: "编辑器", icon: Keyboard },
      { id: "appearance", label: "外观", icon: Palette },
    ],
  },
  {
    id: "integrations",
    label: "集成",
    items: [
      { id: "model", label: "模型", icon: Cpu },
      { id: "databases", label: "数据库", icon: Database },
    ],
  },
  {
    id: "agent",
    label: "Agent",
    items: [
      { id: "skill-iteration", label: "Skill 迭代", icon: Sparkles },
      { id: "permissions", label: "权限", icon: ShieldCheck },
      { id: "hil-approval", label: "HIL 审批", icon: ListChecks },
      { id: "runtime-limits", label: "运行限制", icon: Timer },
    ],
  },
];

const FLAT_ITEMS = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);

export function getSettingsNavItem(id: string): SettingsNavItem | undefined {
  return FLAT_ITEMS.find((item) => item.id === id);
}

export function getSettingsNavGroup(id: string): SettingsNavGroup | undefined {
  return SETTINGS_NAV_GROUPS.find((group) => group.id === id);
}

export const DEFAULT_SETTINGS_SECTION = "model";
