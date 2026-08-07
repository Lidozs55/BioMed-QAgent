import {
  CheckCircleIcon,
  ClockCountdownIcon,
  InfoIcon,
  ProhibitIcon,
  StopCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { Spinner } from "@/components/ui/spinner";
import type { BuildResultStatus, RunStatus } from "@/runtime/contracts";

export function TaskStatusIcon({
  status,
  buildStatus,
  className,
}: {
  status: RunStatus;
  buildStatus?: BuildResultStatus;
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
      return buildStatus === "no_data" ? (
        <InfoIcon className={className} aria-hidden="true" />
      ) : buildStatus === "spec_rejected" ? (
        <ProhibitIcon className={className} aria-hidden="true" />
      ) : (
        <CheckCircleIcon className={className} aria-hidden="true" />
      );
    case "failed":
      return <WarningCircleIcon className={className} aria-hidden="true" />;
    case "cancelled":
      return <ProhibitIcon className={className} aria-hidden="true" />;
    case "interrupted":
      return <StopCircleIcon className={className} aria-hidden="true" />;
  }
}
