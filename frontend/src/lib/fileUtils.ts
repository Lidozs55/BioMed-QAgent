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

export interface FileTypeMeta {
  Icon: Icon;
  label: string;
}

export function fileType(name: string): FileTypeMeta {
  const ext = getExtension(name);
  switch (ext) {
    case "csv":
    case "tsv":
      return { Icon: FileCsvIcon, label: ext.toUpperCase() };
    case "json":
    case "jsonl":
      return { Icon: FileCodeIcon, label: ext.toUpperCase() };
    case "txt":
    case "md":
      return { Icon: FileTextIcon, label: ext.toUpperCase() };
    default:
      return {
        Icon: ext ? FileDashedIcon : FileArchiveIcon,
        label: ext ? ext.toUpperCase() : "FILE",
      };
  }
}
