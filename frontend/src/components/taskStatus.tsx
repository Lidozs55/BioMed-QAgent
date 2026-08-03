import {
  CheckCircleIcon,
  ClockCountdownIcon,
  InfoIcon,
  ProhibitIcon,
  StopCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { Spinner } from "@/components/ui/spinner";
import type { RunStatus } from "@/runtime/contracts";
import type { TaskOutcome } from "@/components/taskOutcome";

export function TaskStatusIcon({
  status,
  outcome,
  className,
}: {
  status: RunStatus;
  outcome?: TaskOutcome;
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
      return outcome === "no_data" ? (
        <InfoIcon className={className} aria-hidden="true" />
      ) : (
        <CheckCircleIcon className={className} aria-hidden="true" />
      );
    case "failed":
      return outcome === "no_data" ? (
        <InfoIcon className={className} aria-hidden="true" />
      ) : (
        <WarningCircleIcon className={className} aria-hidden="true" />
      );
    case "cancelled":
      return <ProhibitIcon className={className} aria-hidden="true" />;
    case "interrupted":
      return <StopCircleIcon className={className} aria-hidden="true" />;
  }
}
