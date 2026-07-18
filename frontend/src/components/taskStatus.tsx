import {
  CheckCircleIcon,
  ClockCountdownIcon,
  ProhibitIcon,
  StopCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { Spinner } from "@/components/ui/spinner";
import type { RunStatus } from "@/runtime/contracts";

export function TaskStatusIcon({
  status,
  className,
}: {
  status: RunStatus;
  className?: string;
}) {
  switch (status) {
    case "queued":
      return <ClockCountdownIcon className={className} aria-hidden="true" />;
    case "running":
    case "finalizing":
    case "cancel_requested":
    case "awaiting_user_input":
      return <Spinner className={className} aria-hidden="true" />;
    case "completed":
      return <CheckCircleIcon className={className} aria-hidden="true" />;
    case "failed":
      return <WarningCircleIcon className={className} aria-hidden="true" />;
    case "cancelled":
      return <ProhibitIcon className={className} aria-hidden="true" />;
    case "interrupted":
      return <StopCircleIcon className={className} aria-hidden="true" />;
  }
}
