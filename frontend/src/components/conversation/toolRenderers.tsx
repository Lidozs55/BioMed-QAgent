import type { ComponentType } from "react";

import type { ToolCallItem } from "@/runtime/types";
import { SkillMarker } from "./SkillMarker";

export type ToolRenderer = ComponentType<{ item: ToolCallItem }>;

/** 工具名 → 自定义渲染器。未注册的工具由 ToolCallStep 走默认 Bubble。 */
export const toolRenderers: Readonly<Record<string, ToolRenderer>> = {
  find_skill: SkillMarker,
  invoke_skill: SkillMarker,
};
