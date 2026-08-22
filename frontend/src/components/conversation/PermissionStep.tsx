import { CheckCircleIcon, ShieldWarningIcon, XCircleIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@/components/ui/marker";
import type { PermissionItem } from "@/runtime/types";

interface PermissionStepProps {
  item: PermissionItem;
}

const STATUS_LABEL: Record<PermissionItem["status"], string> = {
  requested: "等待授权",
  allowed: "已允许",
  denied: "已拒绝",
};

export function PermissionStep({ item }: PermissionStepProps) {
  const Icon = item.status === "allowed"
    ? CheckCircleIcon
    : item.status === "denied"
      ? XCircleIcon
      : ShieldWarningIcon;
  return (
    <Marker variant="border" role="status">
      <MarkerIcon><Icon aria-hidden="true" /></MarkerIcon>
      <MarkerContent className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="break-words">{item.summary}</span>
        <Badge variant="outline">{item.capability}</Badge>
        <Badge variant={item.status === "denied" ? "destructive" : "secondary"}>
          {STATUS_LABEL[item.status]}
        </Badge>
        {item.grantScope !== null ? (
          <Badge variant="ghost">scope={item.grantScope}</Badge>
        ) : null}
      </MarkerContent>
    </Marker>
  );
}
