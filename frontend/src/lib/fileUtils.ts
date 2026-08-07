import {
  FileArchiveIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileDashedIcon,
  FileTextIcon,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function getExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

export function triggerArtifactDownload(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export interface FileTypeMeta {
  Icon: Icon;
  label: string;
}

const ROLE_LABELS: Record<string, string> = {
  primary_dataset: "主数据",
  supporting_dataset: "辅助数据",
  schema: "结构定义",
  provenance: "溯源信息",
  audit_report: "审计报告",
};

const KNOWN_FILENAME_LABELS: Record<string, string> = {
  "main_data.csv": "主数据",
  "sample_metadata.csv": "辅助数据",
  "source_list.csv": "审计报告",
  "cleaning_report.csv": "审计报告",
  "quality_report.csv": "审计报告",
  "source_relations.csv": "审计报告",
  "source_assets.csv": "审计报告",
  "schema.json": "结构定义",
  "field_descriptions.csv": "结构定义",
  "field_mapping.csv": "溯源信息",
  "run_manifest.json": "结构定义",
};

const KNOWN_FILENAME_ICONS: Record<string, Icon> = {
  "main_data.csv": FileCsvIcon,
  "sample_metadata.csv": FileCsvIcon,
  "source_list.csv": FileCsvIcon,
  "cleaning_report.csv": FileCsvIcon,
  "quality_report.csv": FileCsvIcon,
  "source_relations.csv": FileCsvIcon,
  "source_assets.csv": FileCsvIcon,
  "schema.json": FileCodeIcon,
  "field_descriptions.csv": FileCsvIcon,
  "field_mapping.csv": FileCsvIcon,
  "run_manifest.json": FileCodeIcon,
};

export function fileType(name: string, role?: string): FileTypeMeta {
  const ext = getExtension(name);
  // Role takes priority for label; known filenames provide fallback when role is absent/unknown
  const roleLabel = role ? ROLE_LABELS[role] ?? undefined : undefined;
  const filenameFallback = roleLabel === undefined ? KNOWN_FILENAME_LABELS[name] : undefined;
  const label = roleLabel ?? filenameFallback;
  // Icon: known filenames take priority over extension when role is absent
  const filenameIcon = roleLabel === undefined && !role ? KNOWN_FILENAME_ICONS[name] : undefined;
  if (filenameIcon !== undefined) {
    return { Icon: filenameIcon, label: label ?? ext.toUpperCase() };
  }
  switch (ext) {
    case "csv":
    case "tsv":
      return {
        Icon: FileCsvIcon,
        label: label ?? ext.toUpperCase(),
      };
    case "json":
    case "jsonl":
      return {
        Icon: FileCodeIcon,
        label: label ?? ext.toUpperCase(),
      };
    case "txt":
    case "md":
      return {
        Icon: FileTextIcon,
        label: label ?? ext.toUpperCase(),
      };
    default:
      return {
        Icon: ext ? FileDashedIcon : FileArchiveIcon,
        label: label ?? (ext ? ext.toUpperCase() : "FILE"),
      };
  }
}
