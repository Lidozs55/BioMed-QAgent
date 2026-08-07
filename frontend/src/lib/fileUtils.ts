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

export function fileType(name: string, role?: string): FileTypeMeta {
  const ext = getExtension(name);
  const roleLabel = role ? ROLE_LABELS[role] ?? undefined : undefined;
  switch (ext) {
    case "csv":
    case "tsv":
      return {
        Icon: FileCsvIcon,
        label: roleLabel ?? ext.toUpperCase(),
      };
    case "json":
    case "jsonl":
      return {
        Icon: FileCodeIcon,
        label: roleLabel ?? ext.toUpperCase(),
      };
    case "txt":
    case "md":
      return {
        Icon: FileTextIcon,
        label: roleLabel ?? ext.toUpperCase(),
      };
    default:
      return {
        Icon: ext ? FileDashedIcon : FileArchiveIcon,
        label: roleLabel ?? (ext ? ext.toUpperCase() : "FILE"),
      };
  }
}
