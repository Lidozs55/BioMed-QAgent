import type { ComponentType } from "react";
import {
  DownloadSimpleIcon,
  GearIcon,
  MagnifyingGlassIcon,
  PackageIcon,
  SealCheckIcon,
  WrenchIcon,
} from "@phosphor-icons/react";

import type { OperationItem } from "@/runtime/types";

/**
 * Display-label resolution for operation events (T3 contract): the wire
 * ``label`` wins, falling back to ``operation_id`` then ``category`` so old
 * events.jsonl without ``label`` still render something readable.
 */
export function operationDisplayLabel(
  operation: Pick<OperationItem, "label" | "operationId" | "category">,
): string {
  const label = operation.label?.trim();
  if (label !== undefined && label !== "") return label;
  if (operation.operationId.trim() !== "") return operation.operationId;
  const category = operation.category?.trim();
  if (category !== undefined && category !== "") return category;
  return "操作";
}

export interface OperationCategoryMeta {
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** Tailwind text-color class applied to the icon. */
  color: string;
}

const OPERATION_CATEGORY_META: Readonly<Record<string, OperationCategoryMeta>> = {
  discovery: {
    label: "文献/数据发现",
    icon: MagnifyingGlassIcon,
    color: "text-sky-600 dark:text-sky-400",
  },
  acquisition: {
    label: "数据获取",
    icon: DownloadSimpleIcon,
    color: "text-indigo-500 dark:text-indigo-400",
  },
  processing: {
    label: "数据处理",
    icon: GearIcon,
    color: "text-amber-600 dark:text-amber-400",
  },
  artifact_build: {
    label: "产物构建",
    icon: PackageIcon,
    color: "text-emerald-600 dark:text-emerald-400",
  },
  validation: {
    label: "结果验证",
    icon: SealCheckIcon,
    color: "text-violet-600 dark:text-violet-400",
  },
};

const DEFAULT_OPERATION_CATEGORY: OperationCategoryMeta = {
  label: "操作",
  icon: WrenchIcon,
  color: "text-muted-foreground",
};

/** Category-derived icon/color; unknown categories (e.g. binding ids) degrade to a default. */
export function operationCategoryMeta(
  category: string | null,
): OperationCategoryMeta {
  if (category === null) return DEFAULT_OPERATION_CATEGORY;
  return OPERATION_CATEGORY_META[category] ?? DEFAULT_OPERATION_CATEGORY;
}
